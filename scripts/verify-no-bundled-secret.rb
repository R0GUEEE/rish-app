#!/usr/bin/env ruby
# frozen_string_literal: true

# Conservative release guardrail. It is not a proof that a tree contains no
# secrets. It reports only locations and never prints matched values.

require 'find'
require 'optparse'
require 'open3'
require 'set'

project_root = File.expand_path('..', __dir__)
options = { tracked: false, candidate: false, history: nil, max_bytes: 128 * 1024 * 1024 }
OptionParser.new do |parser|
  parser.banner = 'usage: verify-no-bundled-secret.rb [ROOT ...] [options]'
  parser.on('--tracked', 'scan only files tracked by Git') { options[:tracked] = true }
  parser.on('--candidate', 'scan tracked plus normal untracked files (Git candidate set)') { options[:candidate] = true }
  parser.on('--history REF', 'scan every unique blob in all refs plus REF') { |ref| options[:history] = ref }
  parser.on('--max-bytes N', Integer, 'fail if a file/blob exceeds N bytes') { |size| options[:max_bytes] = size }
end.parse!

roots = ARGV.empty? ? [project_root] : ARGV.map { |path| File.expand_path(path) }
excluded_segments = %w[.git .build node_modules Pods build Vendor]

candidate_root = project_root
if options[:candidate] || options[:tracked]
  abort 'candidate/tracked mode accepts at most one scan root' if roots.length > 1
  candidate_root = roots.first
  abort "scan root does not exist: #{candidate_root}" unless File.directory?(candidate_root)
end

# Finite provider/API credential families and a complete private-key envelope.
# A PEM header alone is intentionally insufficient: the body and matching end
# marker are required. There are no directory or nearby-text exemptions.
secret_shape = Regexp.union(
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s+[A-Za-z0-9+\/=\r\n]{32,}\s+-----END [A-Z0-9 ]*PRIVATE KEY-----/i,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /npm_[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /AIza[A-Za-z0-9_-]{20,}/,
  # OpenAI/Anthropic credential bodies may contain both '-' and '_'. Known
  # OpenSSH algorithm false-positives are removed below by exact full-token
  # allowlist, never by allowing a prefix or directory.
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/i,
  /[0-9a-f]{32}\.[A-Za-z0-9]{16,}/i,
)

# Exact synthetic values are permitted for self-tests and only when the full
# matched token equals one of these fixed values. Context words never matter.
synthetic_exact = Set.new([
  "ghp_#{'0' * 24}",
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  "sk-test_#{'0' * 24}",
])
non_secret_exact = Set.new([
  'sk-ecdsa-sha2-nistp256-cert-v01',
  # Public SSH algorithm name in pinned libssh2 src/userauth.c.
  'sk-ssh-ed25519-cert-v01',
])

scanned_count = 0
skipped = []
leaks = []
history_commit_count = 0
history_blob_count = 0

candidate = lambda do |content|
  content = content.b
  content.to_enum(:scan, secret_shape).map { Regexp.last_match[0] }.any? do |match|
    !synthetic_exact.include?(match) && !non_secret_exact.include?(match)
  end
end

inspect_bytes = lambda do |label, content|
  if content.bytesize > options[:max_bytes]
    skipped << label
    next
  end
  scanned_count += 1
  leaks << label if candidate.call(content)
end

if options[:history]
  _resolved_ref, ref_status = Open3.capture2('git', '-C', project_root, 'rev-parse', '--verify', options[:history])
  abort "cannot resolve Git history ref: #{options[:history]}" unless ref_status.success?
  commits, status = Open3.capture2('git', '-C', project_root, 'rev-list', '--all', options[:history])
  abort "cannot enumerate all Git history refs plus #{options[:history]}" unless status.success?
  commits.each_line.map(&:strip).reject(&:empty?).each { history_commit_count += 1 }

  objects, status = Open3.capture2('git', '-C', project_root, 'rev-list', '--objects', '--all', options[:history])
  abort 'cannot enumerate reachable Git objects' unless status.success?
  object_paths = {}
  objects.each_line do |line|
    oid, path = line.strip.split(' ', 2)
    object_paths[oid] ||= path
  end
  blob_ids = object_paths.keys.select do |oid|
    type, type_status = Open3.capture2('git', '-C', project_root, 'cat-file', '-t', oid)
    abort "cannot inspect Git object #{oid}" unless type_status.success?
    type.strip == 'blob'
  end
  history_blob_count = blob_ids.length
  blob_ids.each do |oid|
    content, blob_status = Open3.capture2('git', '-C', project_root, 'cat-file', 'blob', oid)
    abort "cannot read Git blob #{oid}" unless blob_status.success?
    inspect_bytes.call("#{options[:history]}:#{object_paths[oid] || oid}", content)
  end
else
  paths = if options[:candidate]
            candidates, status = Open3.capture2('git', '-C', candidate_root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
            abort 'cannot enumerate Git candidate files' unless status.success?
            deleted, deleted_status = Open3.capture2('git', '-C', candidate_root, 'ls-files', '-z', '--deleted')
            abort 'cannot enumerate deleted Git candidate files' unless deleted_status.success?
            deleted_paths = Set.new(deleted.split("\0").reject(&:empty?))
            candidates.split("\0").reject(&:empty?).reject { |relative| deleted_paths.include?(relative) }.map { |relative| File.join(candidate_root, relative) }
          elsif options[:tracked]
            tracked, status = Open3.capture2('git', '-C', candidate_root, 'ls-files', '-z')
            abort 'cannot enumerate tracked files' unless status.success?
            tracked.split("\0").reject(&:empty?).map { |relative| File.join(candidate_root, relative) }
          else
            roots.flat_map do |root|
              abort "scan root does not exist: #{root}" unless File.exist?(root)
              found = []
              Find.find(root) do |path|
                if File.symlink?(path)
                  found << path
                  Find.prune
                  next
                end
                if File.directory?(path)
                  Find.prune if excluded_segments.include?(File.basename(path))
                  next
                end
                found << path if File.file?(path)
              end
              found
            end
          end
  paths.each do |path|
    if File.symlink?(path)
      # Scan the link text itself and never follow it outside the release tree.
      inspect_bytes.call(path, File.readlink(path).b)
      next
    end
    size = File.size(path)
    if size > options[:max_bytes]
      skipped << path
      next
    end
    inspect_bytes.call(path, File.binread(path))
  rescue Errno::EACCES
    abort "cannot inspect file during secret scan: #{path}"
  end
end

unless leaks.empty?
  leaks.each { |label| warn "candidate location: #{label}" }
  abort "secret-shaped candidates found at #{leaks.length} location(s); values suppressed"
end
unless skipped.empty?
  abort "scan incomplete: #{skipped.length} file/blob(s) exceeded --max-bytes; values suppressed"
end

puts "secret scan passed; files_or_blobs_scanned=#{scanned_count}, skipped_by_size=0; values suppressed"
puts "history commits scanned=#{history_commit_count}, unique blobs scanned=#{history_blob_count}" if options[:history]

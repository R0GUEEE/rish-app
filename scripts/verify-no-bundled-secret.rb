#!/usr/bin/env ruby
# frozen_string_literal: true

require 'find'

project_root = File.expand_path('..', __dir__)
roots = ARGV.empty? ? [project_root] : ARGV.map { |path| File.expand_path(path) }
excluded_segments = %w[.git .build node_modules Pods build Vendor]
key_shape = /sk-[0-9a-f]{32,}/i
scanned = 0
leaks = []

roots.each do |root|
  abort "scan root does not exist: #{root}" unless File.exist?(root)
  Find.find(root) do |path|
    if File.directory?(path)
      relative_segments = path.delete_prefix(project_root).split(File::SEPARATOR)
      Find.prune if root == project_root && (relative_segments & excluded_segments).any?
      next
    end
    next unless File.file?(path)
    next if File.size(path) > 128 * 1024 * 1024

    scanned += 1
    leaks << path if File.binread(path).match?(key_shape)
  rescue Errno::EACCES
    abort "cannot inspect file during secret scan: #{path}"
  end
end

unless leaks.empty?
  abort "DeepSeek key-shaped material found in:\n#{leaks.join("\n")}"
end

puts "secret scan passed across #{scanned} files; no key values printed"

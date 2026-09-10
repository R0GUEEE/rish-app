#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'open3'
require 'tmpdir'

scanner = File.expand_path('../verify-no-bundled-secret.rb', __dir__)
root = Dir.mktmpdir('rish-secret-scanner-')
begin
  samples = {
    'ios/Tests/real.txt' => 'ghp_' + ('A' * 24),
    'androidTest/real.txt' => 'sk-proj-' + ('B' * 24),
    'androidTest/real-separators.txt' => 'sk-proj-' + ('B' * 10) + '-_' + ('C' * 14),
    'near-example.txt' => 'example ghp_' + ('C' * 24),
    'explicit-fake.txt' => 'ghp_' + ('0' * 24),
    'blob.bin' => "\0ASIA" + ('D' * 16),
    'glm.txt' => ('a' * 32) + '.' + ('E' * 16),
    'openssh-algorithm.txt' => 'sk-ecdsa-sha2-nistp256-cert-v01',
  }
  samples.each do |relative, content|
    path = File.join(root, relative)
    FileUtils.mkdir_p(File.dirname(path))
    File.binwrite(path, content)
  end

  checks = [
    [['ios/Tests'], false],
    [['androidTest'], false],
    [['near-example.txt'], false],
    [['explicit-fake.txt'], true],
    [['blob.bin'], false],
    [['glm.txt'], false],
    [['openssh-algorithm.txt'], true],
  ]
  checks.each do |arguments, expected_success|
    _output, status = Open3.capture2e('ruby', scanner, *arguments.map { |path| File.join(root, path) })
    abort "unexpected scanner result for #{arguments.first}" unless status.success? == expected_success
  end

  _output, status = Open3.capture2e('ruby', scanner, '--history', 'ref-does-not-exist')
  abort 'unresolvable Git ref was accepted' if status.success?
  _output, status = Open3.capture2e('ruby', scanner, '--max-bytes', '2', File.join(root, 'blob.bin'))
  abort 'size skip was accepted' if status.success?

  # Candidate mode must include a normal untracked file while excluding
  # ignored assets. The value is assembled here and is never printed.
  untracked = File.expand_path('.secret-scanner-untracked.tmp', __dir__)
  begin
    File.write(untracked, 'ghp_' + ('U' * 24))
    _output, status = Open3.capture2e('ruby', scanner, '--candidate')
    abort 'untracked candidate was not detected' if status.success?
  ensure
    FileUtils.rm_f(untracked)
  end

  # Candidate mode must discard a tracked path that is explicitly deleted
  # while still scanning a new untracked path from a working-tree rename.
  # Use a throwaway Git repository so this test never stages or mutates the
  # real candidate tree.
  renamed_root = Dir.mktmpdir('rish-secret-scanner-rename-')
  begin
    old_path = File.join(renamed_root, 'DSHMobile', 'legacy.txt')
    new_path = File.join(renamed_root, 'Rish', 'renamed.swift')
    FileUtils.mkdir_p(File.dirname(old_path))
    File.write(old_path, 'tracked-safe-content')
    _output, status = Open3.capture2e('git', '-C', renamed_root, 'init', '-q')
    abort 'could not initialize rename fixture' unless status.success?
    _output, status = Open3.capture2e('git', '-C', renamed_root, 'add', 'DSHMobile/legacy.txt')
    abort 'could not stage rename fixture' unless status.success?
    FileUtils.rm_f(old_path)
    FileUtils.mkdir_p(File.dirname(new_path))
    File.write(new_path, 'safe-renamed-content')
    _output, status = Open3.capture2e('ruby', scanner, '--candidate', renamed_root)
    abort 'deleted tracked path was not excluded from candidate scan' unless status.success?

    File.write(new_path, 'ghp_' + ('R' * 24))
    _output, status = Open3.capture2e('ruby', scanner, '--candidate', renamed_root)
    abort 'untracked renamed candidate was not detected' if status.success?
  ensure
    FileUtils.remove_entry(renamed_root)
  end
  puts 'verify-no-bundled-secret self-tests passed'
ensure
  FileUtils.remove_entry(root)
end

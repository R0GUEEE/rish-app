#!/usr/bin/env ruby
# frozen_string_literal: true

# Fails when the Xcode project reuses one object identifier for two different
# entries. Parallel branches that each add fixtures or test files pick ids by
# hand, and a collision silently drops one resource from the test bundle
# instead of failing the build. Run before committing a project.pbxproj change.

require 'set'

project = ARGV[0] || File.expand_path('../ios/DSHMobile.xcodeproj/project.pbxproj', __dir__)
abort "not a file: #{project}" unless File.file?(project)

DEFINITION = /^\t*([0-9A-F]{24}) \/\* (.+?) \*\/ = \{isa = (\w+)/.freeze

names = Hash.new { |hash, key| hash[key] = Set.new }
File.foreach(project) do |line|
  match = DEFINITION.match(line)
  next if match.nil?

  names[match[1]] << "#{match[3]} #{match[2]}"
end

collisions = names.select { |_id, entries| entries.size > 1 }
if collisions.empty?
  puts "pbxproj identifiers are unique (#{names.size} definitions)"
  exit 0
end

collisions.each do |id, entries|
  warn "duplicate identifier #{id}:"
  entries.sort.each { |entry| warn "  #{entry}" }
end
warn ''
warn 'Give one of each pair a fresh 24-hex-digit identifier and rerun.'
exit 1

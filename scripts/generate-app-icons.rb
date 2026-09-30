#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'open3'

root = File.expand_path('..', __dir__)
source = File.join(root, 'brand', 'dsh-app-icon-1024.png')
abort "missing icon master: #{source}" unless File.file?(source)

platform_flag = ARGV.first
valid_flags = [nil, '--ios-only']
abort "usage: #{File.basename($PROGRAM_NAME)} [--ios-only]" unless valid_flags.include?(platform_flag)

ios_root = File.join(
  root,
  'apps/mobile/ios/Rish/Images.xcassets/AppIcon.appiconset',
)

def resize(source, output, size)
  FileUtils.mkdir_p(File.dirname(output))
  text, status = Open3.capture2e(
    'sips', '-z', size.to_s, size.to_s, source, '--out', output,
  )
  abort "icon resize failed for #{output}: #{text}" unless status.success?
end

{
  'Icon-20@2x.png' => 40,
  'Icon-20@3x.png' => 60,
  'Icon-29@2x.png' => 58,
  'Icon-29@3x.png' => 87,
  'Icon-40@2x.png' => 80,
  'Icon-40@3x.png' => 120,
  'Icon-60@2x.png' => 120,
  'Icon-60@3x.png' => 180,
  'Icon-iPad-20.png' => 20,
  'Icon-iPad-20@2x.png' => 40,
  'Icon-iPad-29.png' => 29,
  'Icon-iPad-29@2x.png' => 58,
  'Icon-iPad-40.png' => 40,
  'Icon-iPad-40@2x.png' => 80,
  'Icon-iPad-76.png' => 76,
  'Icon-iPad-76@2x.png' => 152,
  'Icon-iPad-83.5@2x.png' => 167,
  'Icon-1024.png' => 1024,
}.each do |name, size|
  resize(source, File.join(ios_root, name), size)
end

puts 'generated iOS icon artwork'

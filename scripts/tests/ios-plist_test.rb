# frozen_string_literal: true

require 'minitest/autorun'
require 'tmpdir'
require_relative '../ci/ios-plist'

class IOSPlistTest < Minitest::Test
  def test_binary_archive_metadata_preserves_bundle_and_version
    skip 'requires macOS plutil' unless RUBY_PLATFORM.include?('darwin')

    expected = {
      'CFBundleIdentifier' => 'tech.zseven.rish.taskactivity',
      'CFBundleShortVersionString' => '1.0.0',
      'CFBundleVersion' => '3.1',
      'CFBundleDisplayName' => 'Rish 任务'
    }
    Dir.mktmpdir('rish-plist-test-') do |directory|
      file = File.join(directory, 'Info.plist')
      File.write(file, JSON.generate(expected))
      assert system('/usr/bin/plutil', '-convert', 'binary1', file)
      assert_equal 'bplist00', File.binread(file, 8)
      assert_equal expected, IOSPlist.read(file)
    end
  end
end

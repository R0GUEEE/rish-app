# frozen_string_literal: true

require 'json'
require 'open3'

module IOSPlist
  # Archived Info.plist files are binary. Older xcodeproj releases try to
  # interpret their bytes as UTF-8 before decoding; plutil handles both formats.
  def self.read(path)
    json, status = Open3.capture2('/usr/bin/plutil', '-convert', 'json', '-o', '-', path)
    raise "Cannot decode plist: #{path}" unless status.success?

    JSON.parse(json)
  end
end

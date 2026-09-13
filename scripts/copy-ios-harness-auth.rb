require 'json'
require 'digest'
require 'fileutils'
source, destination = ARGV
abort 'error: expected source and destination directories' unless source && destination
manifest_path = File.join(source, 'HarnessAuthAssets.json')
manifest = JSON.parse(File.read(manifest_path))
assets = manifest.fetch('harnesses').values.flat_map do |entry|
  %w[kernel initrd].map do |kind|
    resource = entry.fetch("#{kind}_resource")
    abort "error: invalid auth asset path" unless resource.start_with?('HarnessAuth/') && !resource.split('/').include?('..')
    relative = resource.delete_prefix('HarnessAuth/')
    path = File.join(source, relative)
    abort "error: missing or corrupt auth asset: #{relative}" unless File.file?(path) && Digest::SHA256.file(path).hexdigest == entry.fetch("#{kind}_sha256")
    relative
  end
end.uniq
FileUtils.mkdir_p(destination)
assets.each do |relative|
  target = File.join(destination, relative)
  FileUtils.mkdir_p(File.dirname(target))
  FileUtils.cp(File.join(source, relative), target)
  abort "error: auth asset copy mismatch: #{relative}" unless Digest::SHA256.file(target).hexdigest == Digest::SHA256.file(File.join(source, relative)).hexdigest
end
FileUtils.cp(manifest_path, File.join(destination, 'HarnessAuthAssets.json'))
puts "Verified and copied #{assets.length} auth runtime assets"

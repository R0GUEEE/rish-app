#!/usr/bin/env ruby
# frozen_string_literal: true

require 'base64'
require 'fileutils'
require 'open3'
require 'securerandom'
require 'time'
require 'tmpdir'
require 'xcodeproj'
require_relative 'ios-plist'

ROOT = File.expand_path('../..', __dir__)
OUTPUT = File.join(ROOT, '.build/testflight')

def run!(*args)
  abort "Command failed: #{args.first}" unless system(*args)
end

abort 'Signing is only supported on an ephemeral GitHub-hosted runner' unless ENV['GITHUB_ACTIONS'] == 'true' && ENV['RUNNER_ENVIRONMENT'] == 'github-hosted'
version = ENV.fetch('RELEASE_VERSION')
build = ENV.fetch('RELEASE_BUILD')
abort 'Invalid version' unless version.match?(/\A\d{1,4}\.\d{1,2}(\.\d{1,2})?\z/)
abort 'Invalid build number' unless build.match?(/\A\d+\.\d+\z/)

private_dir = Dir.mktmpdir('rish-signing-', ENV.fetch('RUNNER_TEMP'))
keychain = File.join(private_dir, 'signing.keychain-db')
profiles_installed = []
original_keychains, status = Open3.capture2('security', 'list-keychains', '-d', 'user')
abort 'Cannot read keychain search list' unless status.success?
original_keychains = original_keychains.scan(/"([^"]+)"/).flatten

begin
  FileUtils.mkdir_p(OUTPUT)
  password = SecureRandom.hex(32)
  certificate = File.join(private_dir, 'distribution.p12')
  File.binwrite(certificate, Base64.strict_decode64(ENV.fetch('IOS_DISTRIBUTION_CERTIFICATE_BASE64').gsub(/\s/, '')))
  File.chmod(0o600, certificate)
  run!('security', 'create-keychain', '-p', password, keychain)
  run!('security', 'set-keychain-settings', '-lut', '21600', keychain)
  run!('security', 'unlock-keychain', '-p', password, keychain)
  run!('security', 'import', certificate, '-k', keychain,
       '-P', ENV.fetch('IOS_DISTRIBUTION_CERTIFICATE_PASSWORD'), '-T', '/usr/bin/codesign')
  run!('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain)
  run!('security', 'list-keychains', '-d', 'user', '-s', keychain, *original_keychains)

  targets = {
    'Rish' => ['tech.zseven.rish', 'IOS_PROVISIONING_PROFILE_BASE64'],
    'RishTaskActivity' => ['tech.zseven.rish.taskactivity', 'IOS_EXTENSION_PROVISIONING_PROFILE_BASE64']
  }
  project = Xcodeproj::Project.open(File.join(ROOT, 'apps/mobile/ios/Rish.xcodeproj'))
  mapping = {}
  team = nil
  targets.each do |name, (bundle_id, secret)|
    profile = File.join(private_dir, "#{name}.mobileprovision")
    File.binwrite(profile, Base64.strict_decode64(ENV.fetch(secret).gsub(/\s/, '')))
    xml, decoded = Open3.capture2('security', 'cms', '-D', '-i', profile)
    abort "Cannot decode #{name} profile" unless decoded.success?
    plist = File.join(private_dir, "#{name}.plist")
    File.write(plist, xml)
    data = Xcodeproj::Plist.read_from_path(plist)
    profile_team = data.fetch('TeamIdentifier').first
    team ||= profile_team
    abort 'Profiles belong to different Apple teams' unless team == profile_team
    entitlements = data.fetch('Entitlements')
    prefix = data.fetch('ApplicationIdentifierPrefix').first
    abort "Wrong bundle ID in #{name} profile" unless entitlements['application-identifier'] == "#{prefix}.#{bundle_id}"
    abort "#{name} needs an App Store distribution profile" if data.key?('ProvisionedDevices') || data['ProvisionsAllDevices'] || entitlements['get-task-allow']
    abort "Expired #{name} profile" unless Time.parse(data.fetch('ExpirationDate').to_s) > Time.now
    uuid = data.fetch('UUID')
    abort 'Invalid profile UUID' unless uuid.match?(/\A[0-9A-Fa-f-]+\z/)
    destination = File.expand_path("~/Library/Developer/Xcode/UserData/Provisioning Profiles/#{uuid}.mobileprovision")
    FileUtils.mkdir_p(File.dirname(destination))
    abort 'Refusing to replace an installed profile' if File.exist?(destination)
    FileUtils.cp(profile, destination)
    profiles_installed << destination
    mapping[bundle_id] = uuid
    target = project.targets.find { |candidate| candidate.name == name } or abort "Missing target #{name}"
    config = target.build_configurations.find { |candidate| candidate.name == 'Release' }
    config.build_settings.merge!('CODE_SIGN_STYLE' => 'Manual', 'DEVELOPMENT_TEAM' => team,
                                'CODE_SIGN_IDENTITY' => 'Apple Distribution',
                                'CODE_SIGN_IDENTITY[sdk=iphoneos*]' => 'Apple Distribution',
                                'PROVISIONING_PROFILE_SPECIFIER' => uuid)
  end
  project.save
  options = File.join(OUTPUT, 'ExportOptions.plist')
  Xcodeproj::Plist.write_to_path({ 'method' => 'app-store-connect', 'destination' => 'export',
    'teamID' => team, 'signingStyle' => 'manual', 'signingCertificate' => 'Apple Distribution',
    'provisioningProfiles' => mapping, 'manageAppVersionAndBuildNumber' => false,
    'stripSwiftSymbols' => true, 'uploadSymbols' => true }, options)
  archive = File.join(OUTPUT, 'Rish.xcarchive')
  run!('xcodebuild', '-workspace', 'ios/Rish.xcworkspace', '-scheme', 'Rish',
       '-configuration', 'Release', '-destination', 'generic/platform=iOS',
       '-archivePath', archive, "MARKETING_VERSION=#{version}", "CURRENT_PROJECT_VERSION=#{build}", 'archive')
  app = File.join(archive, 'Products/Applications/Rish.app')
  { app => 'tech.zseven.rish', File.join(app, 'PlugIns/RishTaskActivity.appex') => 'tech.zseven.rish.taskactivity' }.each do |bundle, identifier|
    info = IOSPlist.read(File.join(bundle, 'Info.plist'))
    abort 'Archive bundle identity/version mismatch' unless info['CFBundleIdentifier'] == identifier &&
      info['CFBundleShortVersionString'] == version && info['CFBundleVersion'] == build
    run!('codesign', '--verify', '--strict', bundle)
  end
  run!('ruby', File.join(ROOT, 'scripts/verify-no-bundled-secret.rb'), app)
  run!('xcodebuild', '-exportArchive', '-archivePath', archive,
       '-exportPath', File.join(OUTPUT, 'export'), '-exportOptionsPlist', options)
ensure
  system('security', 'list-keychains', '-d', 'user', '-s', *original_keychains)
  system('security', 'delete-keychain', keychain) if File.exist?(keychain)
  profiles_installed.each { |path| FileUtils.rm_f(path) }
  FileUtils.remove_entry(private_dir)
end

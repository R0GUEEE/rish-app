#!/usr/bin/env ruby
# frozen_string_literal: true

require 'base64'
require 'json'
require 'net/http'
require 'openssl'
require 'yaml'

credential_path = ENV.fetch('DSH_CREDENTIALS', File.expand_path('~/.dsh/.credentials.yaml'))
image_only = ARGV.delete('--image-only')
image_path = ARGV.fetch(0) { abort 'usage: probe-deepseek-vision.rb <png-path>' }
credential_stat = File.lstat(credential_path)
abort 'credential source must be a regular file, not a symlink' unless credential_stat.file? && !credential_stat.symlink?
abort 'credential source must be owned by the current user' unless credential_stat.uid == Process.uid
abort 'credential source permissions must be 0600' unless (credential_stat.mode & 0o777) == 0o600
credential = YAML.safe_load(File.read(credential_path), permitted_classes: [], aliases: false)
key = credential.dig('refs', 'DEEPSEEK_API_KEY')
abort 'credential unavailable' unless key.is_a?(String) && key.length.between?(16, 512)

bytes = File.binread(image_path)
abort 'probe image is too large' if bytes.empty? || bytes.bytesize > 8 * 1024 * 1024
content_parts = []
unless image_only
  content_parts << { type: 'text', text: 'If you can see an image, reply exactly: vision-ok' }
end
content_parts << {
  type: 'image_url',
  image_url: { url: "data:image/png;base64,#{Base64.strict_encode64(bytes)}" },
}
body = {
  model: 'deepseek-v4-flash-vision-exp',
  stream: false,
  thinking: { type: 'disabled' },
  max_tokens: 64,
  messages: [
    {
      role: 'user',
      content: content_parts,
    },
  ],
}

uri = URI('https://api.deepseek.com/chat/completions')
request = Net::HTTP::Post.new(uri)
request['Content-Type'] = 'application/json'
request['Authorization'] = "Bearer #{key}"
begin
  request.body = JSON.generate(body)
  response = Net::HTTP.start(uri.host, uri.port, use_ssl: true) do |http|
    http.verify_mode = OpenSSL::SSL::VERIFY_PEER
    http.open_timeout = 15
    http.read_timeout = 90
    http.request(request)
  end
  decoded = JSON.parse(response.body)
  puts JSON.generate(
    status: response.code.to_i,
    model: decoded['model'],
    finish_reason: decoded.dig('choices', 0, 'finish_reason'),
    content: decoded.dig('choices', 0, 'message', 'content'),
    error: decoded.dig('error', 'message'),
  )
ensure
  request.delete('Authorization')
  key.replace("\0" * key.bytesize)
end

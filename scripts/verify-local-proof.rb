#!/usr/bin/env ruby
# frozen_string_literal: true

require 'json'
require 'open3'
require 'digest'
require 'time'

def canonical_json_value(value)
  case value
  when Hash
    value.keys.sort.to_h { |key| [key, canonical_json_value(value.fetch(key))] }
  when Array
    value.map { |entry| canonical_json_value(entry) }
  else
    value
  end
end

def json_sha256(value)
  Digest::SHA256.hexdigest(JSON.generate(canonical_json_value(value)))
end

udid = ARGV.fetch(0) { abort 'usage: verify-local-proof.rb <simulator-udid> [bundle-id]' }
bundle_id = ARGV.fetch(1, 'dev.zseven.dsh.mobile')

listener = `lsof -nP -iTCP:3180 -sTCP:LISTEN`
abort "Mac DSH port 3180 is still listening:\n#{listener}" unless listener.empty?

container, status = Open3.capture2e(
  'xcrun', 'simctl', 'get_app_container', udid, bundle_id, 'data',
)
abort "cannot resolve Simulator app container: #{container.strip}" unless status.success?

proof_path = File.join(
  container.strip,
  'Library',
  'Application Support',
  'runtime-proof.json',
)
abort "runtime proof is missing: #{proof_path}" unless File.file?(proof_path)

proof = JSON.parse(File.read(proof_path))
abort 'runtime proof schema is not current' unless proof['schema_version'] == 2
checks = proof.fetch('checks')
required = %w[
  credential_in_keychain
  model_response_received
  session_restored_after_restart
  rish_applet_executed
]
missing = required.reject { |key| checks[key] == true }
abort "runtime proof has incomplete checks: #{missing.join(', ')}" unless missing.empty?
abort 'runtime proof does not identify the iOS Simulator' unless proof['platform'] == 'ios_simulator'
abort 'runtime proof overclaims full local DSH' unless proof['mode'] == 'local_substrate'
abort 'runtime proof has the wrong product' unless proof['product'] == 'rish'
abort 'runtime proof has the wrong active harness' unless proof['active_harness'] == 'dsh'
abort 'runtime proof has the wrong bundle id' unless proof['bundle_id'] == bundle_id
abort 'runtime proof says the Mac DSH proxy was reachable' unless proof['mac_dsh_port_3180_reachable'] == false

generated_at = Time.iso8601(proof.fetch('generated_at'))
age = Time.now - generated_at
abort "runtime proof is stale (#{age.round}s old)" unless age.between?(-300, 1800)

rish = proof.fetch('rish_probe')
expected_stdout = "#{Digest::SHA256.hexdigest('dsh-mobile-local-proof')}  -\n"
abort 'rish proof has the wrong protocol' unless rish['protocol_version'] == 1
abort 'rish proof did not execute sha256sum' unless rish['program'] == 'sha256sum'
abort 'rish proof did not exit successfully' unless rish['exit_code'] == 0
abort 'rish proof did not use a portable applet' unless rish['path_kind'] == 'portable_applet'
abort 'rish proof has the wrong applet receipt' unless rish['path_name'] == 'sha256sum'
abort 'rish proof stdout does not match the fresh input' unless rish['stdout'] == expected_stdout

proof_run_id = proof.fetch('proof_run_id')
abort 'proof run id is malformed' unless proof_run_id.match?(/\A[0-9a-f-]{36}\z/)
model = proof.fetch('model_response')
persisted = proof.fetch('session_persisted')
restored = proof.fetch('session_restore')
[model, persisted, restored].each do |section|
  abort 'proof sections belong to different runs' unless section['proof_run_id'] == proof_run_id
end
abort 'model response did not come from DeepSeek' unless model['model'] == 'deepseek-v4-flash'
abort 'model request did not complete over HTTP' unless model['http_status'] == 200
abort 'model stopped without a final response' unless model['finish_reason'] == 'stop'
abort 'model response id is missing' if model['response_id'] == 'unreported'
request_id = model.fetch('request_id')
abort 'model request id is malformed' unless request_id.match?(/\A[0-9a-f-]{36}\z/)
abort 'persisted session belongs to another request' unless persisted['request_id'] == request_id
abort 'restored session belongs to another request' unless restored['request_id'] == request_id

session_path = File.join(
  container.strip,
  'Library',
  'Application Support',
  proof.fetch('session_store'),
)
abort "session store is missing: #{session_path}" unless File.file?(session_path)
session_bytes = File.binread(session_path)
session_envelope = JSON.parse(session_bytes)
abort 'session schema is not current' unless session_envelope['schema_version'] == 2
abort 'session and proof run ids differ' unless session_envelope['proof_run_id'] == proof_run_id
abort 'session and proof request ids differ' unless session_envelope['proof_request_id'] == request_id
session_digest = Digest::SHA256.hexdigest(session_bytes)
abort 'persisted session digest does not match the container file' unless persisted['sha256'] == session_digest
abort 'restored session digest does not match the container file' unless restored['sha256'] == session_digest

messages = session_envelope.dig('session', 'messages')
abort 'restored session is not a message array' unless messages.is_a?(Array)
abort 'restored session does not contain a completed turn' unless messages.length >= 2
abort 'restored session has no user message' unless messages.any? { |message| message['role'] == 'user' && !message['text'].to_s.empty? }
abort 'restored session has no assistant message' unless messages.any? { |message| message['role'] == 'assistant' && !message['text'].to_s.empty? }
abort 'persisted message count does not match' unless persisted['message_count'] == messages.length
abort 'restored message count does not match' unless restored['message_count'] == messages.length

projected_messages = messages.map do |message|
  {'role' => message.fetch('role'), 'content' => message.fetch('text')}
end
request_count = model.fetch('request_message_count')
abort 'request message count cannot identify the final assistant response' unless request_count.positive? && request_count + 1 == projected_messages.length
history = projected_messages.first(request_count)
assistant = projected_messages.last
abort 'proof does not end in an assistant response' unless assistant['role'] == 'assistant'
history_digest = json_sha256(history)
assistant_digest = Digest::SHA256.hexdigest(assistant.fetch('content'))
reasoning = messages.last.dig('metadata', 'reasoning').to_s
reasoning_digest = reasoning.empty? ? 'none' : Digest::SHA256.hexdigest(reasoning)
abort 'model request history hash does not match the session' unless model['request_history_sha256'] == history_digest
abort 'persisted request history hash does not match the session' unless persisted['request_history_sha256'] == history_digest
abort 'model assistant hash does not match the session' unless model['assistant_text_sha256'] == assistant_digest
abort 'persisted assistant hash does not match the session' unless persisted['assistant_text_sha256'] == assistant_digest
abort 'model reasoning hash does not match the session' unless model['reasoning_text_sha256'] == reasoning_digest
abort 'persisted reasoning hash does not match the session' unless persisted['reasoning_text_sha256'] == reasoning_digest

writer_launch = session_envelope.fetch('writer_launch_instance_id')
current_launch = proof.fetch('launch_instance_id')
abort 'session was not restored across a process launch' if writer_launch == current_launch
abort 'model response and session writer launches differ' unless model['launch_instance_id'] == writer_launch
abort 'persisted writer launch does not match the session' unless persisted['writer_launch_instance_id'] == writer_launch
abort 'restored writer launch does not match the session' unless restored['writer_launch_instance_id'] == writer_launch
abort 'restore did not occur in the current app launch' unless restored['restore_launch_instance_id'] == current_launch

processes, process_status = Open3.capture2e(
  'xcrun', 'simctl', 'spawn', udid, '/bin/ps', '-axo', 'pid=,comm=',
)
abort "cannot read Simulator process table: #{processes.strip}" unless process_status.success?
expected_pid = proof.fetch('process_id').to_i
process_line = processes.lines.find do |line|
  line.match?(/^\s*#{expected_pid}\s+/) && line.include?('DSHMobile')
end
abort "runtime proof PID #{expected_pid} is not a live Simulator DSHMobile process" if process_line.nil?

puts JSON.pretty_generate(proof)

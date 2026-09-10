# Security policy (draft)

This file is a draft and does not claim that a private vulnerability-reporting
channel is currently enabled. A current repository check did not confirm a
working private submission route. Do not disclose sensitive details in a
public issue while the owner decides how reports should be handled.

## Scope

Please treat these as security-sensitive boundaries:

- provider credentials and native Keychain/Keystore storage;
- project, Files, Git, guest, and workspace isolation;
- path traversal, symlink handling, `.git` exposure, and destructive actions;
- bundled guest binaries, downloaded dependencies, and integrity checks;
- credential or private-key values crossing into JavaScript, logs, fixtures, or
  generated app products.

The current source tree is not a complete `local_harness` or production
distribution. Missing platform features are tracked separately from security
vulnerabilities.

## Reporting

Do not include API keys, access tokens, private keys, passwords, user data, or
full credential-bearing URLs in a report. Redact reproduction data and provide
the smallest useful description, affected revision, platform, and safe steps
to reproduce.

There is currently no confirmed private submission channel to list here.
Please do not assume that a public issue, pull request, or the private
document center is a secure reporting path. The owner may enable a repository
private mechanism or publish another route later.

## Handling and disclosure

Response times, supported versions, coordinated disclosure, credit, and
security-fix release policy have not yet been defined. They remain optional
owner policy to document if and when a reporting channel is enabled.

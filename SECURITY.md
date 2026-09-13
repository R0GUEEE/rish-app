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

Report vulnerabilities privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not use a public
issue, pull request, or discussion for anything exploitable.

## Handling and disclosure

Reports are acknowledged through the same private thread. Response times,
supported versions, coordinated disclosure, credit, and security-fix release
policy are not yet formalised and will be documented here as they are decided.

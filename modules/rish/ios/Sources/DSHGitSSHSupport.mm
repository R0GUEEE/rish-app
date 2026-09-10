#import "DSHGitSSHSupport.h"

#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>

#include <algorithm>
#include <arpa/inet.h>
#include <string.h>

NSString *const DSHGitSSHCredentialService = @"dev.zseven.rish.git.ssh";

static NSError *DSHSSHError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:@"DSHGitSSHSupport" code:code
                          userInfo:@{NSLocalizedDescriptionKey: message}];
}

static BOOL DSHSSHControl(NSString *value) {
  for (NSUInteger i = 0; i < value.length; i += 1) {
    unichar c = [value characterAtIndex:i];
    if (c == 0 || c < 0x20 || c == 0x7f) return YES;
  }
  return NO;
}

static BOOL DSHSSHMultiline(NSString *value, NSUInteger max, BOOL allowEmpty) {
  if (![value isKindOfClass:NSString.class] || (!allowEmpty && value.length == 0) ||
      [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > max) return NO;
  for (NSUInteger i = 0; i < value.length; i += 1) {
    unichar c = [value characterAtIndex:i];
    if (c == 0 || (c < 0x20 && c != '\r' && c != '\n') || c == 0x7f) return NO;
  }
  return YES;
}

static NSString *DSHSSHStripBrackets(NSString *host) {
  if ([host hasPrefix:@"["] && [host hasSuffix:@"]"] && host.length > 2)
    return [host substringWithRange:NSMakeRange(1, host.length - 2)];
  return host;
}

static BOOL DSHSSHHost(NSString *host) {
  if (host.length == 0 || host.length > 253 || [host hasSuffix:@"."] ||
      DSHSSHControl(host) || [host containsString:@"/"] ||
      [host containsString:@"\\"] || [host isEqualToString:@"localhost"])
    return NO;
  NSString *plain = DSHSSHStripBrackets(host);
  struct in_addr v4 = {};
  struct in6_addr v6 = {};
  const char *bytes = plain.UTF8String;
  if (bytes != nullptr && (inet_pton(AF_INET, bytes, &v4) == 1 ||
                           inet_pton(AF_INET6, bytes, &v6) == 1)) return YES;
  NSArray<NSString *> *labels = [plain componentsSeparatedByString:@"."];
  if (labels.count < 2) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"];
  for (NSString *label in labels) {
    if (label.length == 0 || label.length > 63 || [label hasPrefix:@"-"] ||
        [label hasSuffix:@"-"] ||
        [label rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound)
      return NO;
  }
  return YES;
}

static BOOL DSHSSHUser(NSString *user) {
  if (user.length == 0 || user.length > 255 || DSHSSHControl(user) ||
      [user rangeOfCharacterFromSet:
          [NSCharacterSet characterSetWithCharactersInString:@"/@\\:"]].location != NSNotFound)
    return NO;
  return YES;
}

static BOOL DSHSSHPath(NSString *path, BOOL absolute) {
  if (path.length == 0 || path.length > 2048 || DSHSSHControl(path) ||
      [path containsString:@"\\"] || (absolute && ![path hasPrefix:@"/"])) return NO;
  for (NSString *part in [path componentsSeparatedByString:@"/"]) {
    if ([part isEqualToString:@"."] || [part isEqualToString:@".."] ||
        [part containsString:@"\0"]) return NO;
  }
  return YES;
}

NSDictionary *DSHGitSSHValidatedRemote(id value, NSError **error) {
  NSString *input = [value isKindOfClass:NSString.class] ? value : @"";
  if (input.length == 0 || input.length > 4096 || DSHSSHControl(input) ||
      ![input isEqualToString:[input stringByTrimmingCharactersInSet:
          NSCharacterSet.whitespaceAndNewlineCharacterSet]]) {
    if (error) *error = DSHSSHError(4001, @"SSH remote is invalid");
    return nil;
  }

  NSString *user = nil;
  NSString *host = nil;
  NSString *path = nil;
  NSInteger port = 22;
  BOOL scp = NO;
  if ([input.lowercaseString hasPrefix:@"ssh://"]) {
    NSURLComponents *components = [NSURLComponents componentsWithString:input];
    user = components.user;
    host = components.host.lowercaseString;
    path = components.path;
    port = components.port == nil ? 22 : components.port.integerValue;
    if (components.password != nil || components.query != nil ||
        components.fragment != nil || components.port != nil &&
            (port < 1 || port > 65535) || !DSHSSHPath(path, YES)) {
      host = nil;
    }
  } else {
    NSRange at = [input rangeOfString:@"@"];
    NSRange colon = [input rangeOfString:@":" options:0 range:NSMakeRange(
        at.location == NSNotFound ? 0 : at.location + 1, input.length -
            (at.location == NSNotFound ? 0 : at.location + 1))];
    if (at.location != NSNotFound && colon.location != NSNotFound &&
        [input rangeOfString:@"@" options:0 range:NSMakeRange(at.location + 1,
            input.length - at.location - 1)].location == NSNotFound) {
      user = [input substringToIndex:at.location];
      host = [[input substringWithRange:NSMakeRange(at.location + 1,
          colon.location - at.location - 1)] lowercaseString];
      path = [input substringFromIndex:colon.location + 1];
      scp = YES;
      if (!DSHSSHPath(path, NO)) host = nil;
    }
  }
  if (!DSHSSHUser(user) || !DSHSSHHost(host) || !DSHSSHPath(path, scp ? NO : YES) ||
      port < 1 || port > 65535) {
    if (error) *error = DSHSSHError(4001, @"SSH remote is invalid");
    return nil;
  }
  NSString *canonical = [NSString stringWithFormat:@"ssh://%@%@%@%@/%@", user,
      @"@",
      [host containsString:@":"] ? [NSString stringWithFormat:@"[%@]", host] : host,
      port == 22 ? @"" : [NSString stringWithFormat:@":%ld", (long)port],
      [path hasPrefix:@"/"] ? [path substringFromIndex:1] : path];
  return @{ @"url": input, @"canonical_url": canonical, @"host": host,
            @"username": user, @"port": @(port), @"path": path, @"scp": @(scp) };
}

static NSMutableDictionary *DSHSSHQuery(NSString *account) {
  return [@{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
             (__bridge id)kSecAttrService: DSHGitSSHCredentialService,
             (__bridge id)kSecAttrAccount: account,
             (__bridge id)kSecAttrSynchronizable: @NO} mutableCopy];
}

static BOOL DSHSSHString(NSString *value, NSUInteger max, BOOL allowEmpty) {
  return [value isKindOfClass:NSString.class] && (allowEmpty || value.length > 0) &&
      value.length <= max && !DSHSSHControl(value);
}

static NSString *DSHSSHFingerprint(NSString *publicKey) {
  if (!DSHSSHString(publicKey, 16384, NO)) return nil;
  NSArray<NSString *> *parts = [publicKey componentsSeparatedByCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSMutableArray *fields = [NSMutableArray array];
  for (NSString *part in parts) if (part.length) [fields addObject:part];
  if (fields.count < 2) return nil;
  NSData *blob = [[NSData alloc] initWithBase64EncodedString:fields[1] options:0];
  if (blob.length == 0) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {};
  CC_SHA256(blob.bytes, (CC_LONG)blob.length, digest);
  NSString *encoded = [[NSData dataWithBytes:digest length:sizeof(digest)]
      base64EncodedStringWithOptions:0];
  return encoded.length > 0 ? [@"SHA256:" stringByAppendingString:
      [encoded stringByReplacingOccurrencesOfString:@"=" withString:@""]] : nil;
}

static BOOL DSHSSHProfileID(NSString *profileId) {
  return DSHSSHString(profileId, 128, NO);
}

static NSString *DSHSSHAccount(NSString *profileId) {
  return [NSString stringWithFormat:@"profile:%@", profileId];
}

NSDictionary *DSHGitSSHCredentialForProfile(NSString *profileId, NSString *host,
                                           NSInteger port, NSString *username,
                                           NSError **error) {
  if (!DSHSSHProfileID(profileId) || !DSHSSHHost(host) || !DSHSSHUser(username) ||
      port < 1 || port > 65535) return nil;
  NSMutableDictionary *query = DSHSSHQuery(DSHSSHAccount(profileId));
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef raw = nullptr;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &raw);
  if (status != errSecSuccess || raw == nullptr) {
    if (raw) CFRelease(raw);
    if (status != errSecItemNotFound && status != errSecSuccess && error)
      *error = DSHSSHError(4016, @"SSH credential status is unavailable");
    return nil;
  }
  NSData *data = CFBridgingRelease(raw);
  id decoded = data.length <= 1200000
      ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![decoded isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *payload = (NSDictionary *)decoded;
  id schema = payload[@"schema_version"];
  id privateValue = payload[@"private_key"];
  id publicValue = payload[@"public_key"];
  id passphraseValue = payload[@"passphrase"];
  id knownHostsValue = payload[@"known_hosts"];
  id storedHostValue = payload[@"host"];
  id storedPortValue = payload[@"port"];
  id storedUserValue = payload[@"username"];
  if (![schema isKindOfClass:NSNumber.class] || ![schema isEqual:@1] ||
      ![privateValue isKindOfClass:NSString.class] ||
      ![publicValue isKindOfClass:NSString.class] ||
      ![passphraseValue isKindOfClass:NSString.class] ||
      ![knownHostsValue isKindOfClass:NSString.class] ||
      ![storedHostValue isKindOfClass:NSString.class] ||
      ![storedPortValue isKindOfClass:NSNumber.class] ||
      ![storedUserValue isKindOfClass:NSString.class] ||
      ![((NSString *)storedHostValue).lowercaseString isEqualToString:host.lowercaseString] ||
      [storedPortValue integerValue] != port ||
      ![storedUserValue isEqualToString:username]) return nil;
  NSString *privateKey = (NSString *)privateValue;
  NSString *publicKey = (NSString *)publicValue;
  NSString *passphrase = (NSString *)passphraseValue;
  NSString *knownHosts = (NSString *)knownHostsValue;
  if (!DSHSSHMultiline(privateKey, 131072, NO) ||
      !DSHSSHString(publicKey, 16384, YES) || !DSHSSHString(passphrase, 4096, YES) ||
      !DSHSSHMultiline(knownHosts, 1048576, NO)) return nil;
  return @{@"private_key": privateKey, @"public_key": publicKey ?: @"",
           @"passphrase": passphrase ?: @"", @"known_hosts": knownHosts,
           @"host": payload[@"host"], @"port": payload[@"port"],
           @"username": payload[@"username"], @"key_fingerprint":
               payload[@"key_fingerprint"] ?: NSNull.null};
}

NSDictionary *DSHGitSSHCredentialStatusForProfile(NSString *profileId, NSError **error) {
  if (!DSHSSHProfileID(profileId)) return nil;
  NSMutableDictionary *query = DSHSSHQuery(DSHSSHAccount(profileId));
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef raw = nullptr;
  OSStatus itemStatus = SecItemCopyMatching((__bridge CFDictionaryRef)query, &raw);
  if (itemStatus == errSecItemNotFound) return nil;
  if (itemStatus != errSecSuccess || raw == nullptr) {
    if (raw) CFRelease(raw);
    if (error) *error = DSHSSHError(4016, @"SSH credential status is unavailable");
    return nil;
  }
  NSData *data = CFBridgingRelease(raw);
  id decoded = data.length <= 1200000
      ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![decoded isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *payload = (NSDictionary *)decoded;
  NSString *host = [payload[@"host"] isKindOfClass:NSString.class] ? payload[@"host"] : nil;
  NSString *username = [payload[@"username"] isKindOfClass:NSString.class] ? payload[@"username"] : nil;
  NSNumber *port = [payload[@"port"] isKindOfClass:NSNumber.class] ? payload[@"port"] : nil;
  if (![payload[@"schema_version"] isEqual:@1] || !DSHSSHHost(host) ||
      !DSHSSHUser(username) || port.integerValue < 1 || port.integerValue > 65535) return nil;
  NSMutableDictionary *status = [@{@"profile_id": profileId, @"host": host,
      @"port": port, @"username": username, @"configured": @YES} mutableCopy];
  if ([payload[@"key_fingerprint"] isKindOfClass:NSString.class])
    status[@"key_fingerprint"] = payload[@"key_fingerprint"];
  return status;
}

BOOL DSHGitSSHStoreCredentialForProfile(NSString *profileId, NSString *host,
                                      NSInteger port, NSString *username,
                                      NSString *privateKey, NSString *publicKey,
                                      NSString *passphrase, NSString *knownHosts,
                                      NSError **error) {
  if (!DSHSSHProfileID(profileId) || !DSHSSHHost(host) || !DSHSSHUser(username) ||
      port < 1 || port > 65535 || !DSHSSHMultiline(privateKey, 131072, NO) ||
      ![privateKey containsString:@"-----BEGIN"] ||
      !DSHSSHString(publicKey ?: @"", 16384, YES) ||
      !DSHSSHString(passphrase ?: @"", 4096, YES) || passphrase.length > 0 ||
      !DSHSSHMultiline(knownHosts, 1048576, NO)) {
    if (error) *error = DSHSSHError(4012, @"SSH credential is invalid");
    return NO;
  }
  if (!DSHGitSSHPrivateKeyIsSupported(privateKey, error)) return NO;
  NSString *fingerprint = DSHSSHFingerprint(publicKey);
  NSMutableDictionary *payload = [@{
      @"schema_version": @1, @"host": host, @"port": @(port),
      @"username": username, @"private_key": privateKey,
      @"public_key": publicKey ?: @"", @"passphrase": passphrase ?: @"",
      @"known_hosts": knownHosts} mutableCopy];
  if (fingerprint != nil) payload[@"key_fingerprint"] = fingerprint;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload
      options:NSJSONWritingSortedKeys error:nil];
  if (data == nil || data.length > 1200000) {
    if (error) *error = DSHSSHError(4012, @"SSH credential is invalid");
    return NO;
  }
  NSMutableDictionary *query = DSHSSHQuery(DSHSSHAccount(profileId));
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query,
      (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData: data});
  if (status == errSecItemNotFound) {
    query[(__bridge id)kSecValueData] = data;
    query[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
    status = SecItemAdd((__bridge CFDictionaryRef)query, nil);
  }
  if (status != errSecSuccess) {
    if (error) *error = DSHSSHError(4013, @"SSH credential cannot be saved");
    return NO;
  }
  return YES;
}

BOOL DSHGitSSHDeleteCredentialForProfile(NSString *profileId, NSString *host,
                                       NSInteger port, NSString *username,
                                       NSError **error) {
  if (!DSHSSHProfileID(profileId)) return NO;
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)DSHSSHQuery(
      DSHSSHAccount(profileId)));
  if (status != errSecSuccess && status != errSecItemNotFound) {
    if (error) *error = DSHSSHError(4014, @"SSH credential cannot be cleared");
    return NO;
  }
  return YES;
}

BOOL DSHGitSSHPrivateKeyIsSupported(NSString *privateKey, NSError **error) {
  if (!DSHSSHMultiline(privateKey, 131072, NO) ||
      ![privateKey containsString:@"-----BEGIN"]) {
    if (error) *error = DSHSSHError(4012, @"SSH private key is invalid");
    return NO;
  }
  if ([privateKey containsString:@"Proc-Type: 4,ENCRYPTED"] ||
      [privateKey containsString:@"DEK-Info:"]) {
    if (error) *error = DSHSSHError(4017, @"Encrypted SSH keys require the native secure passphrase flow");
    return NO;
  }
  NSRange begin = [privateKey rangeOfString:@"-----BEGIN OPENSSH PRIVATE KEY-----"];
  if (begin.location == NSNotFound) return YES;
  NSRange end = [privateKey rangeOfString:@"-----END OPENSSH PRIVATE KEY-----"];
  if (end.location == NSNotFound || end.location <= begin.location) {
    if (error) *error = DSHSSHError(4012, @"SSH private key is invalid");
    return NO;
  }
  NSString *body = [privateKey substringWithRange:NSMakeRange(
      begin.location + begin.length, end.location - begin.location - begin.length)];
  body = [[body componentsSeparatedByCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet] componentsJoinedByString:@""];
  NSData *decoded = [[NSData alloc] initWithBase64EncodedString:body options:0];
  const unsigned char *bytes = (const unsigned char *)decoded.bytes;
  const char magic[] = "openssh-key-v1\0";
  NSUInteger magicLength = sizeof(magic) - 1;
  if (decoded.length < magicLength + 4 || memcmp(bytes, magic, magicLength) != 0) {
    if (error) *error = DSHSSHError(4012, @"SSH private key is invalid");
    return NO;
  }
  NSUInteger offset = magicLength;
  uint32_t length = ((uint32_t)bytes[offset] << 24) | ((uint32_t)bytes[offset + 1] << 16) |
      ((uint32_t)bytes[offset + 2] << 8) | bytes[offset + 3];
  offset += 4;
  if (length == 0 || length > 64 || offset + length > decoded.length) {
    if (error) *error = DSHSSHError(4012, @"SSH private key is invalid");
    return NO;
  }
  NSString *cipher = [[NSString alloc] initWithBytes:bytes + offset
      length:length encoding:NSUTF8StringEncoding];
  if (![cipher isEqualToString:@"none"]) {
    if (error) *error = DSHSSHError(4017, @"Encrypted SSH keys require the native secure passphrase flow");
    return NO;
  }
  return YES;
}

@interface DSHSSHAuthContext : NSObject
@property(nonatomic, copy) NSString *host;
@property(nonatomic, copy) NSString *username;
@property(nonatomic) NSInteger port;
@property(nonatomic, copy) NSDictionary *credential;
@end
@implementation DSHSSHAuthContext
@end

void *DSHGitSSHAuthContextCreate(NSString *profileId, NSString *host, NSInteger port,
                                 NSString *username, NSError **error) {
  NSDictionary *credential = DSHGitSSHCredentialForProfile(profileId, host, port, username, error);
  if (credential == nil) return nullptr;
  DSHSSHAuthContext *context = [DSHSSHAuthContext new];
  context.host = host.lowercaseString;
  context.username = username;
  context.port = port;
  context.credential = credential;
  return (__bridge_retained void *)context;
}

void DSHGitSSHAuthContextFree(void *context) {
  if (context) CFRelease(context);
}

int DSHGitSSHCredentialCallback(git_credential **out, const char *url,
                                const char *username, unsigned int allowedTypes,
                                void *payload) {
  DSHSSHAuthContext *context = (__bridge DSHSSHAuthContext *)payload;
  if (context == nil || out == nullptr || !(allowedTypes & GIT_CREDENTIAL_SSH_MEMORY))
    return GIT_EAUTH;
  NSString *remoteURL = url == nullptr ? nil : [NSString stringWithUTF8String:url];
  NSDictionary *remote = DSHGitSSHValidatedRemote(remoteURL, nil);
  if (remote == nil || ![remote[@"host"] isEqualToString:context.host] ||
      [remote[@"port"] integerValue] != context.port ||
      ![remote[@"username"] isEqualToString:context.username]) return GIT_EAUTH;
  const char *remoteUser = username && username[0] ? username : context.username.UTF8String;
  NSString *publicKey = context.credential[@"public_key"];
  NSString *passphrase = context.credential[@"passphrase"];
  return git_credential_ssh_key_memory_new(out, remoteUser,
      publicKey.length == 0 ? nullptr : publicKey.UTF8String,
      [context.credential[@"private_key"] UTF8String],
      passphrase.length == 0 ? nullptr : passphrase.UTF8String);
}

static BOOL DSHSSHHostTokenMatches(NSString *token, NSString *host, NSInteger port) {
  NSString *plain = host.lowercaseString;
  for (NSString *candidate in [token componentsSeparatedByString:@","]) {
    if ([candidate isEqualToString:plain] && port == 22) return YES;
    if ([candidate isEqualToString:[NSString stringWithFormat:@"[%@]:%ld", plain, (long)port]]) return YES;
  }
  return NO;
}

int DSHGitSSHCertificateCallback(git_cert *cert, int valid, const char *host,
                                 void *payload) {
  (void)valid;
  DSHSSHAuthContext *context = (__bridge DSHSSHAuthContext *)payload;
  if (context == nil || cert == nullptr ||
      cert->cert_type != GIT_CERT_HOSTKEY_LIBSSH2 || host == nullptr)
    return GIT_ECERTIFICATE;
  if (![context.host isEqualToString:[NSString stringWithUTF8String:host].lowercaseString])
    return GIT_ECERTIFICATE;
  if (!(context.credential[@"known_hosts"])) return GIT_ECERTIFICATE;
  git_cert_hostkey *hostkey = (git_cert_hostkey *)cert;
  if (!(hostkey->type & GIT_CERT_SSH_SHA256)) return GIT_ECERTIFICATE;
  NSData *actual = [NSData dataWithBytes:hostkey->hash_sha256 length:CC_SHA256_DIGEST_LENGTH];
  NSArray<NSString *> *lines = [context.credential[@"known_hosts"] componentsSeparatedByCharactersInSet:
      NSCharacterSet.newlineCharacterSet];
  for (NSString *line in lines) {
    NSString *trimmed = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length == 0 || [trimmed hasPrefix:@"#"]) continue;
    NSArray<NSString *> *parts = [trimmed componentsSeparatedByCharactersInSet:
        NSCharacterSet.whitespaceCharacterSet];
    NSMutableArray *fields = [NSMutableArray array];
    for (NSString *part in parts) if (part.length) [fields addObject:part];
    if (fields.count >= 2 && [fields[1] isEqualToString:@"@revoked"] &&
        DSHSSHHostTokenMatches(fields[0], context.host, context.port))
      return GIT_ECERTIFICATE;
    if (fields.count < 3 || !DSHSSHHostTokenMatches(fields[0], context.host, context.port)) continue;
    NSSet *keyTypes = [NSSet setWithObjects:@"ssh-ed25519", @"ssh-rsa",
        @"ecdsa-sha2-nistp256", @"ecdsa-sha2-nistp384",
        @"ecdsa-sha2-nistp521", nil];
    if (![keyTypes containsObject:fields[1]]) continue;
    NSData *known = [[NSData alloc] initWithBase64EncodedString:fields[2] options:0];
    if (known.length == 0) continue;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH] = {};
    CC_SHA256(known.bytes, (CC_LONG)known.length, digest);
    if ([actual isEqualToData:[NSData dataWithBytes:digest length:sizeof(digest)]]) return 0;
  }
  return GIT_ECERTIFICATE;
}

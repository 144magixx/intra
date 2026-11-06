#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <stdlib.h>

// One bounded JSON request on stdin and one captured JSON reply on stdout.
// Secret values are never read from arguments, environment variables, or files.
static void reply(NSDictionary *body, int status) __attribute__((noreturn));
static void failure(void) __attribute__((noreturn));

static void reply(NSDictionary *body, int status) {
    @try {
        NSData *data = [NSJSONSerialization dataWithJSONObject:body options:NSJSONWritingSortedKeys error:NULL];
        if (data == nil) exit(1);
        [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
    } @catch (NSException *exception) {
        // Do not print exception reasons, userInfo, request contents, or stack traces.
        (void)exception;
        exit(1);
    }
    exit(status);
}

static void failure(void) {
    reply(@{@"ok": @NO, @"error": @"KEYCHAIN_UNAVAILABLE"}, 1);
}

int main(void) {
    @autoreleasepool {
        @try {
            const NSUInteger limit = 1024 * 1024;
            NSMutableData *input = [NSMutableData data];
            NSFileHandle *standardInput = [NSFileHandle fileHandleWithStandardInput];
            while (input.length <= limit) {
                NSData *chunk = [standardInput readDataOfLength:MIN((NSUInteger)65536, limit + 1 - input.length)];
                if (chunk.length == 0) break;
                [input appendData:chunk];
            }
            if (input.length > limit) failure();
            id object = [NSJSONSerialization JSONObjectWithData:input options:0 error:NULL];
            if (![object isKindOfClass:[NSDictionary class]]) failure();
            NSDictionary *request = object;
            for (id field in request) {
                if (![@[@"op", @"key", @"value"] containsObject:field]) failure();
            }
            id op = request[@"op"];
            id key = request[@"key"];
            if (![op isKindOfClass:[NSString class]] || ![@[@"get", @"set", @"delete"] containsObject:op] ||
                ![key isKindOfClass:[NSString class]] || [key length] == 0 ||
                [key lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 1024 ||
                [key rangeOfCharacterFromSet:[NSCharacterSet controlCharacterSet]].location != NSNotFound) failure();
            if ([op isEqualToString:@"set"]) {
                if (![request[@"value"] isKindOfClass:[NSString class]]) failure();
            } else if (request[@"value"] != nil) {
                failure();
            }

            NSDictionary *query = @{
                (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
                (__bridge id)kSecAttrService: @"dev.intra.credentials.v1",
                (__bridge id)kSecAttrAccount: key,
                (__bridge id)kSecAttrSynchronizable: @NO
            };
            if ([op isEqualToString:@"get"]) {
                NSMutableDictionary *lookup = [query mutableCopy];
                lookup[(__bridge id)kSecReturnData] = @YES;
                lookup[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
                CFTypeRef result = NULL;
                OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)lookup, &result);
                id stored = CFBridgingRelease(result);
                if (status == errSecItemNotFound) reply(@{@"ok": @YES, @"value": [NSNull null]}, 0);
                if (status != errSecSuccess || ![stored isKindOfClass:[NSData class]]) failure();
                NSString *value = [[NSString alloc] initWithData:stored encoding:NSUTF8StringEncoding];
                if (value == nil) failure();
                reply(@{@"ok": @YES, @"value": value}, 0);
            }
            if ([op isEqualToString:@"set"]) {
                NSData *stored = [request[@"value"] dataUsingEncoding:NSUTF8StringEncoding];
                if (stored == nil) failure();
                NSDictionary *attributes = @{(__bridge id)kSecValueData: stored};
                OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
                if (status == errSecItemNotFound) {
                    NSMutableDictionary *item = [query mutableCopy];
                    item[(__bridge id)kSecValueData] = stored;
                    status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
                    if (status == errSecDuplicateItem) {
                        status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
                    }
                }
                if (status != errSecSuccess) failure();
                reply(@{@"ok": @YES}, 0);
            }
            OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
            if (status != errSecSuccess && status != errSecItemNotFound) failure();
            reply(@{@"ok": @YES}, 0);
        } @catch (NSException *exception) {
            (void)exception;
            failure();
        }
    }
}

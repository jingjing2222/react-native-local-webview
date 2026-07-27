#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface LocalWebViewKeyboardWorkarounds : NSObject

+ (void)configureWebView:(WKWebView *)webView
    hideKeyboardAccessoryView:(BOOL)hideKeyboardAccessoryView
    keyboardDisplayRequiresUserAction:(BOOL)keyboardDisplayRequiresUserAction;

@end

NS_ASSUME_NONNULL_END

#import "LocalWebViewKeyboardWorkarounds.h"

#import <objc/runtime.h>

static char LocalWebViewKeyboardOverrideKey;

@interface LocalWebViewNoAccessoryView : NSObject
- (id)inputAccessoryView;
@end

@implementation LocalWebViewNoAccessoryView
- (id)inputAccessoryView {
  return nil;
}
@end

@implementation LocalWebViewKeyboardWorkarounds

+ (UIView *)contentViewForWebView:(WKWebView *)webView {
  for (UIView *view in webView.scrollView.subviews) {
    if ([NSStringFromClass(view.class) hasPrefix:@"WK"]) {
      return view;
    }
  }
  return nil;
}

+ (void)configureWebView:(WKWebView *)webView
    hideKeyboardAccessoryView:(BOOL)hideKeyboardAccessoryView
    keyboardDisplayRequiresUserAction:(BOOL)keyboardDisplayRequiresUserAction {
  UIView *contentView = [self contentViewForWebView:webView];
  if (contentView == nil) {
    return;
  }

  if (!hideKeyboardAccessoryView &&
      [NSStringFromClass(contentView.class) hasSuffix:@"_LocalWebViewNoAccessory"]) {
    object_setClass(contentView, contentView.class.superclass);
  }

  if (hideKeyboardAccessoryView &&
      ![NSStringFromClass(contentView.class) hasSuffix:@"_LocalWebViewNoAccessory"]) {
    NSString *name = [NSString stringWithFormat:@"%@_LocalWebViewNoAccessory",
                                                NSStringFromClass(contentView.class)];
    Class subclass = NSClassFromString(name);
    if (subclass == nil) {
      subclass = objc_allocateClassPair(contentView.class, name.UTF8String, 0);
      Method method =
          class_getInstanceMethod(LocalWebViewNoAccessoryView.class,
                                  @selector(inputAccessoryView));
      class_addMethod(subclass, @selector(inputAccessoryView),
                      method_getImplementation(method),
                      method_getTypeEncoding(method));
      objc_registerClassPair(subclass);
    }
    object_setClass(contentView, subclass);
  }

  if (!keyboardDisplayRequiresUserAction) {
    SEL selector = NSSelectorFromString(
        @"_elementDidFocus:userIsInteracting:blurPreviousNode:"
         "activityStateChanges:userObject:");
    Class contentClass = contentView.class;
    Method method = class_getInstanceMethod(contentClass, selector);
    if (method == NULL) {
      return;
    }
    if (objc_getAssociatedObject(contentClass, &LocalWebViewKeyboardOverrideKey) != nil) {
      return;
    }
    IMP original = method_getImplementation(method);
    IMP replacement = imp_implementationWithBlock(
        ^(id target, void *node, __unused BOOL userIsInteracting,
          BOOL blurPreviousNode, BOOL activityStateChanges, id userObject) {
          ((void (*)(id, SEL, void *, BOOL, BOOL, BOOL, id))original)(
              target, selector, node, YES, blurPreviousNode,
              activityStateChanges, userObject);
        });
    method_setImplementation(method, replacement);
    objc_setAssociatedObject(contentClass, &LocalWebViewKeyboardOverrideKey, @YES,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}

@end

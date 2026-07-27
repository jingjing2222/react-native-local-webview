require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "ReactNativeLocalWebView"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "16.4" }
  s.source       = { :git => package["repository"]["url"], :tag => "#{s.version}" }
  s.source_files = [
    "ios/**/*.{h,m,mm,swift}",
    "nitrogen/generated/ios/**/*.{h,hpp,c,cc,cpp,m,mm,swift}",
    "nitrogen/generated/shared/c++/**/*.{h,hpp,c,cc,cpp}",
  ]
  s.public_header_files = ["ios/**/*.h"]

  load "nitrogen/generated/ios/ReactNativeLocalWebView+autolinking.rb"
  add_nitrogen_files(s)
  install_modules_dependencies(s)
end

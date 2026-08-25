Pod::Spec.new do |spec|
  spec.name = 'RishLocalRuntime'
  spec.version = '0.1.0'
  spec.summary = 'Local DSH substrate proof backed by rish.'
  spec.homepage = 'https://github.com/ZSeven-W/rish'
  spec.license = { type: 'MIT' }
  spec.author = 'ZSeven'
  spec.source = { path: '.' }
  spec.platform = :ios, '15.1'
  spec.source_files = 'Sources/**/*.{h,m,mm}'
  spec.vendored_frameworks = [
    'Vendor/rish_ffi.xcframework',
    'Vendor/libgit2.xcframework',
  ]
  spec.preserve_paths = ['include/rish.h']
  spec.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '"${PODS_TARGET_SRCROOT}/include"',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) DSH_LOCAL_PROOF=1',
  }
  spec.frameworks = [
    'CoreFoundation',
    'Foundation',
    'ImageIO',
    'PDFKit',
    'Photos',
    'PhotosUI',
    'QuickLook',
    'Security',
    'UIKit',
    'UniformTypeIdentifiers',
  ]
  spec.libraries = ['c++']
  spec.dependency 'React-Core'
end

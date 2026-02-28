require 'json'

package = JSON.parse(File.read(File.join(File.dirname(__FILE__), 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorMobileClaw'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/rogelioRuiz/capacitor-mobile-claw'
  s.author = 'Rogelio Ruiz'
  s.source = { :git => 'https://github.com/rogelioRuiz/capacitor-mobile-claw.git', :tag => s.version.to_s }

  s.source_files = 'ios/Plugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '14.0'

  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end

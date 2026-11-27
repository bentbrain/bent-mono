Pod::Spec.new do |s|
  s.name           = 'FitnessCharts'
  s.version        = '0.1.0'
  s.summary        = 'Swift Charts line and bar charts with touch selection for bent Fitness.'
  s.description    = 'Line and bar charts drawn with Swift Charts. Touch and drag, or tap, shows the nearest point with its details.'
  s.author         = 'bent.build'
  s.homepage       = 'https://fitness.bent.build'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Charts', 'SwiftUI'

  s.source_files = '*.swift'
end

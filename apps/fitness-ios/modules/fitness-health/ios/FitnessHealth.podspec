Pod::Spec.new do |s|
  s.name           = 'FitnessHealth'
  s.version        = '0.1.0'
  s.summary        = 'Reads Apple Health weigh-ins and runs and sends them to Fitness.'
  s.description    = 'The sync engine for Fitness Sync: HealthKit queries, the device key and the import client.'
  s.author         = 'bent.build'
  s.homepage       = 'https://fitness.bent.build'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'HealthKit', 'Security'

  s.source_files = 'Module/**/*.swift', 'Core/**/*.swift', 'Platform/**/*.swift'
end

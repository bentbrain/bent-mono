Pod::Spec.new do |s|
  s.name           = 'WorkoutActivity'
  s.version        = '0.1.0'
  s.summary        = 'Shows the workout Live Activity and the timer alert for bent Fitness.'
  s.description    = 'Starts, updates and ends the workout Live Activity, and schedules the local alert for the end of a rest or hold.'
  s.author         = 'bent.build'
  s.homepage       = 'https://fitness.bent.build'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ActivityKit', 'UserNotifications'

  # The extension target compiles ios/Extension; the app compiles the module.
  s.source_files = 'Module/**/*.swift', 'Shared/**/*.swift'
end

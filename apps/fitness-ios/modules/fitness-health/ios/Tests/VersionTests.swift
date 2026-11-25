import XCTest
@testable import FitnessHealthCore

final class VersionTests: XCTestCase {
  func testUserAgentNamesTheApp() {
    XCTAssertTrue(FitnessHealthCore.userAgent.hasPrefix("FitnessSync/"))
  }
}

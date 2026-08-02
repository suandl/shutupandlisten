// Wave 1b tests: the bundled coverage presets and the shared checklist parser.
//
// A preset must be indistinguishable from a hand-typed checklist downstream:
// `criteriaText` round-trips through `Coverage.parseCriteria` (the same
// newline/trim/drop-blanks logic the app applies to its stored Settings text)
// and renders through `Coverage.userMessage` unchanged.

import XCTest
@testable import TurnEngine

final class CoveragePresetsTests: XCTestCase {
    func testLibraryIsNonEmptyWithUniqueIDs() {
        XCTAssertGreaterThanOrEqual(CoveragePresets.all.count, 6)
        let ids = CoveragePresets.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "preset ids must be unique")
    }

    func testEveryPresetIsFullyFormed() {
        for preset in CoveragePresets.all {
            XCTAssertFalse(preset.id.isEmpty)
            XCTAssertFalse(preset.name.isEmpty)
            XCTAssertFalse(preset.blurb.isEmpty)
            XCTAssertGreaterThanOrEqual(preset.criteria.count, 3,
                                        "\(preset.id): a checklist needs at least three lines")
            let topicSet = Set(preset.criteria.map(\.topic))
            XCTAssertEqual(topicSet.count, preset.criteria.count,
                           "\(preset.id): topics must be unique within a preset")
            for criterion in preset.criteria {
                let topic = criterion.topic
                XCTAssertFalse(topic.trimmingCharacters(in: .whitespaces).isEmpty)
                XCTAssertFalse(topic.contains("\n"), "\(preset.id): one topic per line")
                XCTAssertEqual(topic, topic.trimmingCharacters(in: .whitespaces),
                               "\(preset.id): topics ship pre-trimmed")
            }
        }
    }

    func testCriteriaRoundTripThroughTheParsingPath() {
        for preset in CoveragePresets.all {
            XCTAssertEqual(Coverage.parseCriteria(preset.criteriaText), preset.criteria,
                           "\(preset.id): criteriaText must parse back to the same criteria")
        }
    }

    func testParseCriteriaTrimsAndDropsBlankLines() {
        let parsed = Coverage.parseCriteria("  the options on the table  \n\n   \nwhy now\n")
        XCTAssertEqual(parsed.map(\.topic), ["the options on the table", "why now"])
        XCTAssertTrue(Coverage.parseCriteria("").isEmpty)
    }

    func testLookupByID() {
        XCTAssertEqual(CoveragePresets.preset(id: "decision"), CoveragePresets.decision)
        XCTAssertNil(CoveragePresets.preset(id: "no-such-preset"))
    }

    func testSuggestedModesPairSensibly() {
        XCTAssertEqual(CoveragePresets.pitchRehearsal.suggestedMode, .rehearsal)
        XCTAssertEqual(CoveragePresets.salesCallDebrief.suggestedMode, .debrief)
        XCTAssertEqual(CoveragePresets.decision.suggestedMode, .open)
    }

    func testPresetRendersThroughCoverageUserMessage() {
        let message = Coverage.userMessage(
            transcript: "we could go with either vendor",
            criteria: CoveragePresets.decision.criteria
        )
        for criterion in CoveragePresets.decision.criteria {
            XCTAssertTrue(message.contains("- \(criterion.topic)"))
        }
    }
}

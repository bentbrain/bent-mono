import assert from "node:assert/strict";
import test from "node:test";
import { releaseAssetUrl } from "./release-asset-url.mjs";

test("release transfer credentials go only to the exact GitHub repository asset API", () => {
    const valid = "https://api.github.com/repos/bentbrain/bent-mono/releases/assets/123";
    assert.equal(releaseAssetUrl(valid), valid);
    for (const value of [valid.replace("api.github.com", "apiXgithub.com"), valid.replace("api.github.com", "api.github.com.evil.example"),
        valid.replace("https:", "http:"), valid.replace("api.github.com", "user@api.github.com"), `${valid}?next=evil`, `${valid}#evil`,
        valid.replace("bent-mono", "another-repo"), valid.replace("/123", "/../123"), valid.replace("/123", "/0")])
        assert.throws(() => releaseAssetUrl(value));
});

import assert from "node:assert/strict";
import { getManualContext } from "../src/lib/manual-context.ts";

const ready = [
  "laundry",
  "vacuuming",
  "coffee-machine",
  "steamer",
  "bidet",
  "ikea-dials",
  "rubbish",
  "feeding-cats",
  "tv",
];
const question = (text) => ({
  role: "user",
  parts: [{ type: "text", text }],
});
const retrieve = (...questions) =>
  JSON.parse(getManualContext(questions.map(question), ready));

const washer = retrieve("How do I refill the washing machine detergent tank?");
assert.ok(washer.length > 0);
assert.ok(washer.every((p) => p.model === "HWFS1015AB"));
assert.ok(washer.some((p) => /adding detergent/i.test(p.text)));
const dryer = retrieve("How do I empty the dryer water tank?");
assert.ok(dryer.every((p) => p.model === "HDFS90HAB"));
assert.ok(dryer.some((p) => /pull out the.*condensate tank/i.test(p.text)));
const filter = retrieve("How long does the Dyson filter need to dry?");
assert.ok(filter.some((p) => /at least 24 hours/i.test(p.text)));
assert.ok(filter.some((p) => /completely dry/i.test(p.text)));
const robot = retrieve("How do I refill the robot vacuum clean water tank?");
assert.ok(robot.every((p) => p.model === "DEEBOT T50 MAX PRO OMNI"));
assert.ok(robot.some((p) => /max water level/i.test(p.text)));
assert.ok(
  robot.some((p) =>
    /do not add cleaning solution to the water tanks/i.test(p.text),
  ),
);

const followUp = retrieve(
  "How do I use the Dyson?",
  "How do I wash its filter?",
);
assert.ok(followUp.length > 0);
assert.ok(followUp.every((p) => p.model === "V15 Detect Absolute"));
const switchDevice = retrieve(
  "How do I use the Dyson?",
  "How do I empty the dryer tank?",
);
assert.ok(switchDevice.every((p) => p.model === "HDFS90HAB"));
for (const unrelated of [
  "What is on level 10?",
  "Where are the mugs?",
  "What about the gym?",
  "How do I clean the dishwasher filter?",
])
  assert.deepEqual(retrieve("How do I use the Dyson?", unrelated), []);
assert.equal(getManualContext([question("How do I use the Dyson?")], []), "[]");
assert.deepEqual(
  JSON.parse(
    getManualContext(
      [
        { role: "assistant", parts: [{ type: "text", text: "Dyson" }] },
        question("How do I clean its filter?"),
      ],
      ready,
    ),
  ),
  [],
);
const tv = retrieve("How do I charge the Apple TV remote?");
assert.ok(tv.some((p) => /charge/i.test(p.text)));
assert.ok(tv.every((p) => /not confirmed/.test(p.scope)));
const lg = retrieve(
  "Does the LG OLED TV need to stay connected to power for pixel cleaning?",
);
assert.ok(lg.length > 0);
assert.ok(lg.every((p) => p.model === "OLED55G4PSA"));
assert.ok(
  lg.some((p) => /pixel cleaning feature works when.*main power/i.test(p.text)),
);
const hdmi = retrieve("How do I enable SIMPLINK on OLED55G4PSA?");
assert.ok(hdmi.some((p) => /SIMPLINK.*On/.test(p.text)));
assert.ok(
  hdmi.every((p) => /LG remote button names do not refer/.test(p.scope)),
);
const tvSwitch = retrieve(
  "How do I use the Apple TV?",
  "How do I clean the LG TV screen?",
);
assert.ok(tvSwitch.every((p) => p.model === "OLED55G4PSA"));
assert.ok(
  tvSwitch.some((p) => /wipe gently with a soft.*dry cloth/i.test(p.text)),
);
const genericTv = retrieve("How do I use the TV?");
assert.ok(genericTv.some((p) => p.model === "OLED55G4PSA"));
assert.ok(genericTv.some((p) => p.model.startsWith("Apple TV")));
const ambiguous = retrieve("How do I empty the vacuum?");
assert.ok(ambiguous.some((p) => p.model === "V15 Detect Absolute"));
assert.ok(ambiguous.some((p) => p.model === "DEEBOT T50 MAX PRO OMNI"));
const broad = getManualContext(
  [
    question(
      "washer dryer coffee steamer bidet robot vacuum dyson tv clean tank filter water detergent charge",
    ),
  ],
  ready,
);
assert.ok(broad.length <= 14_000);
assert.ok(JSON.parse(broad).length <= 6);
for (const p of JSON.parse(broad))
  assert.equal(new URL(p.url).protocol, "https:");
console.log(
  "PASS: relevant model-specific passages include operating steps and maintenance constraints",
);
console.log(
  "PASS: follow-ups, device changes, published-topic scope and unrelated questions are handled",
);
console.log(
  "PASS: manual context is bounded and references fixed official sources",
);

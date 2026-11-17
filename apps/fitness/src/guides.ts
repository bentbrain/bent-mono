export type Guide = {
  id: string;
  setup: string;
  steps: string[];
  avoid: string;
  video: string;
  credit: string;
};
export const guides: Guide[] = [
  {
    id: "squat",
    setup:
      "Use one light dumbbell held close to your chest. Stand with feet around shoulder width.",
    steps: [
      "Brace your trunk and keep your whole foot on the floor.",
      "Bend at the hips and knees together. Squat to a depth you can control.",
      "Press through the floor to stand. Breathe out as you rise.",
    ],
    avoid:
      "Keep heels down and let knees follow your toes. Reduce depth or load if your back rounds.",
    video: "MeIiIdhvXT4",
    credit: "Scott Herman · Goblet squat",
  },
  {
    id: "bench",
    setup:
      "Set the bench flat. Sit with dumbbells resting on your thighs, then lie back carefully with feet planted.",
    steps: [
      "Draw shoulder blades gently back and down. Keep wrists above elbows.",
      "Lower the dumbbells beside your chest with elbows slightly tucked.",
      "Press upward under control, then lower slowly.",
    ],
    avoid:
      "Use weights you can set up and put down safely. Avoid bouncing, flared elbows and forcing shoulder depth.",
    video: "Y_7aHqXeCfQ",
    credit: "Scott Herman · Dumbbell bench press",
  },
  {
    id: "row",
    setup:
      "Place one hand on a stable bench. Stagger your feet, hinge at the hips and hold a dumbbell in the free hand.",
    steps: [
      "Keep a long, still back and let the weight hang below your shoulder.",
      "Pull your elbow toward your hip without twisting your torso.",
      "Lower the dumbbell slowly, then repeat on the other side.",
    ],
    avoid:
      "Keep shoulders level. Record the dumbbell weight and the reps for each side.",
    video: "KRN38chlkds",
    credit: "Scott Herman · Dumbbell single-arm row on bench",
  },
  {
    id: "rdl",
    setup:
      "Stand tall with a dumbbell in each hand, feet hip width apart and knees softly bent.",
    steps: [
      "Brace, then push your hips backward while keeping weights close to your legs.",
      "Lower only while you can keep a neutral back and feel the hamstrings working.",
      "Push through your feet and bring hips forward to stand.",
    ],
    avoid:
      "This is a hip hinge. Avoid reaching for the floor or bending your knees into a squat.",
    video: "FQKfr1YDhEk",
    credit: "Scott Herman · Dumbbell Romanian deadlift",
  },
  {
    id: "raise",
    setup:
      "Stand with very light dumbbells beside your thighs, elbows slightly bent and trunk steady.",
    steps: [
      "Raise arms outward and slightly forward in a comfortable arc.",
      "Stop around shoulder height or lower if needed.",
      "Lower slowly while keeping your shoulders relaxed.",
    ],
    avoid: "Avoid swinging the weights or shrugging toward your ears.",
    video: "3VcKaXpzqRo",
    credit: "Scott Herman · Lateral raise",
  },
  {
    id: "plank",
    setup:
      "Rest on forearms with elbows beneath shoulders. Extend your legs, balancing on your toes.",
    steps: [
      "Squeeze glutes gently and brace your abdomen.",
      "Keep head, ribs and hips aligned while breathing normally.",
      "End the hold when your hips sag or you cannot keep the position.",
    ],
    avoid:
      "Log seconds, not reps. Try a shorter hold or place knees on the floor to practise.",
    video: "fqzUlmyTpJk",
    credit: "Scott Herman · Plank",
  },
  {
    id: "split",
    setup:
      "Take a stationary staggered stance with both feet on the floor, wide enough side to side to balance. Practise without weights first.",
    steps: [
      "Lower your back knee toward the floor while bending the front knee.",
      "Keep your front foot planted and use a comfortable depth.",
      "Push through the front foot to rise; complete both sides.",
    ],
    avoid:
      "Keep feet stationary. Use light fingertip support if balance limits you. The linked video also covers elevated variations; start with both feet on the floor.",
    video: "4bNQITw0VdY",
    credit: "E3 Rehab · Split squat, basic version at 1:09",
  },
  {
    id: "incline",
    setup:
      "Set the bench to a low incline, around 15–30 degrees. Plant feet and support your head and upper back.",
    steps: [
      "Set shoulder blades gently back. Bring dumbbells beside your upper chest.",
      "Press above your upper chest with wrists stacked over elbows.",
      "Lower under control to a comfortable depth.",
    ],
    avoid:
      "Keep the incline low for this routine. Avoid lifting your hips or straining to get the weights into position.",
    video: "8iPEnn-ltC8",
    credit: "Scott Herman · Incline dumbbell press",
  },
  {
    id: "press",
    setup:
      "Sit against an upright bench backrest, feet flat. Bring light dumbbells to shoulder level.",
    steps: [
      "Brace your trunk and keep ribs stacked above your pelvis.",
      "Press the weights overhead through a comfortable path.",
      "Lower slowly to shoulder level.",
    ],
    avoid:
      "Avoid arching your lower back or forcing a painful range. Use a weight you can bring to your shoulders safely.",
    video: "qEwKCR5JCog",
    credit: "Scott Herman · Dumbbell shoulder press",
  },
  {
    id: "curl",
    setup:
      "Stand with a dumbbell in each hand, palms facing inward and elbows beside your ribs.",
    steps: [
      "Keep upper arms still as you bend elbows and raise the dumbbells.",
      "Keep palms facing inward throughout.",
      "Lower slowly without swinging your body.",
    ],
    avoid:
      "Record the weight of one dumbbell. Each arm performs the logged rep count.",
    video: "zC3nLlEvin4",
    credit: "Scott Herman · Hammer curl",
  },
];

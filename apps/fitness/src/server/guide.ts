import { mcpResource } from "./config";

/**
 * `/llms.txt`: how an AI assistant connects to Fitness and sets up the
 * person's training, for an assistant someone sent the website to.
 */
export function assistantGuide(resource = mcpResource()) {
  const endpoint = resource ?? "https://fitness.bent.build/api/mcp";
  const origin = new URL(endpoint).origin;
  return `# Fitness

> Fitness (${origin}) is a private tracker for strength training, runs, food and bodyweight. A person can set it up with their own AI assistant: the assistant connects to Fitness, asks about their goals, time, equipment and injuries, and proposes a training plan. The plan changes only when the person accepts it in Fitness.

## If someone sent you this website

1. Check they have a Fitness account. Accounts are by invitation; they sign in at ${origin}.
2. Connect to the Fitness MCP server at \`${endpoint}\`. It uses Streamable HTTP and OAuth sign-in.
   - In a chat app such as Claude or ChatGPT, the person adds it themselves: in the app's settings for connectors or custom MCP servers, they add a connector named Fitness with that URL, then sign in to Fitness and approve access. Walk them through it and wait until they've connected.
   - In Claude Code, run \`claude mcp add --transport http fitness ${endpoint}\`, then sign in through \`/mcp\`.
   - Other MCP clients add a remote Streamable HTTP server with that URL and open the Fitness sign-in when asked.
   - Scripts and agents without OAuth sign-in send a Fitness API key as \`Authorization: Bearer <key>\`. The person creates one at ${origin}/account/api-keys.
3. Once connected, start the \`set_up_training\` prompt, or follow the same steps:
   - Call \`fitness_get_training_plan\` to see their current plan.
   - Ask, one or two questions at a time, about their goal, training experience, the days a week and minutes a session they have, the equipment they can use, including dumbbell weights, and any injuries or movements to avoid.
   - Call \`fitness_list_exercises\` and build a plan from catalogue exercises that suit their answers.
   - Show them the plan. When they're happy with it, call \`fitness_propose_plan\` and give them the review link it returns, ${origin}/proposal, where they accept or dismiss it.

## Access

The person approves what a connection can do:

- \`fitness:read\`: read meals, saved meals, bodyweight, runs, planned training and workouts.
- \`fitness:write\`: log, change and remove meals, saved meals, bodyweight and runs.
- \`fitness:targets\`: change daily calorie and protein targets and the nutrients they track.
- \`fitness:plan\`: read the training plan and propose new plans.

An assistant connected before it was given \`fitness:plan\` needs to be removed and connected again to propose plans.

## After setup

The same connection logs meals from a description (\`fitness_add_meals\`), records bodyweight and runs, and reads any day or the last few weeks of history. Strength workouts are recorded in the Fitness app.
`;
}

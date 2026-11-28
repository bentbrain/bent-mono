import { mcpResource, planScopeEnabled } from "./config";

const chatGptSetup =
  "https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt";
const claudeSetup =
  "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp";

/**
 * `/llms.txt`: how an AI assistant connects to Fitness and, when sign-in
 * grants plan access, sets up the person's training. For an assistant
 * someone sent the website to.
 */
export function assistantGuide({
  resource = mcpResource(),
  planning = planScopeEnabled(),
}: { resource?: string | null; planning?: boolean } = {}) {
  const intro = `# Fitness

> Fitness is a private tracker for strength training, runs, food and bodyweight. ${
    planning
      ? "A person can set it up with their own AI assistant: the assistant connects to Fitness, asks about their goals, time, equipment and injuries, and proposes a training plan. The plan changes only when the person accepts it in Fitness."
      : "A person can connect their own AI assistant to log food, bodyweight and runs and to read their training."
  }
`;
  if (!resource)
    return `${intro}
## Connecting

This Fitness server's assistant connection isn't configured, so assistants can't connect to it. Ask the person to contact the app owner.
`;
  const origin = new URL(resource).origin;
  const setup = planning
    ? `
## Setting up training

1. Check the connection lists the \`fitness_propose_plan\` tool. If it doesn't, the person didn't approve plan access: they remove the Fitness connection, connect again and approve every permission.
2. Start the \`set_up_training\` prompt, or follow the same steps:
   - Call \`fitness_get_training_plan\`. If \`plan\` is \`null\`, the person hasn't set up Fitness yet: ask them to open ${origin}, choose **Set up my plan**, and tell you once it has saved. Then call it again.
   - Ask, one or two questions at a time, about their goal, training experience, the days a week and minutes a session they have, the equipment they can use, including dumbbell weights, and any injuries or movements to avoid.
   - Call \`fitness_list_exercises\` and build a plan from catalogue exercises that suit their answers.
   - Show them the plan. When they're happy with it, call \`fitness_propose_plan\` and give them the review link it returns, ${origin}/proposal, where they accept or dismiss it.
`
    : "";
  return `${intro}
## Connecting

1. The person needs a Fitness account. Accounts are by invitation; they sign in at ${origin}.
2. Connect to the Fitness MCP server at \`${resource}\`. It uses Streamable HTTP and OAuth sign-in.
   - In a chat app, the person adds it as a custom connector, then signs in to Fitness and approves access. Custom connectors depend on the app, plan and workspace: see the instructions for ChatGPT (${chatGptSetup}) and Claude (${claudeSetup}). In a team or enterprise workspace, an admin may need to add the connector first. Walk the person through it and wait until they've connected. If their chat app can't add a custom connector, a desktop or command-line assistant that supports remote MCP servers can.
   - In Claude Code, run \`claude mcp add --transport http fitness ${resource}\`, then sign in through \`/mcp\`.
   - Other MCP clients add a remote Streamable HTTP server with that URL and open the Fitness sign-in when asked.
   - Clients that can't sign in send a Fitness API key as \`Authorization: Bearer <key>\`. The person creates one under Manage account → API keys, at ${origin}/account/api-keys. A key created there has every permission below.
${setup}
## What a connection can do

The person approves what a connection can do, and the tools it lists follow that:

- \`fitness:read\`: read a day or up to 62 days of history, with meals, saved meals, bodyweight, runs, planned training and workouts.
- \`fitness:write\`: log, change and remove meals and saved meals, record bodyweight, and log and remove runs.
- \`fitness:targets\`: change daily calorie and protein targets and the nutrients they track.${
    planning
      ? "\n- `fitness:plan`: read the training plan and propose new plans for the person to accept."
      : ""
  }

Strength workouts are recorded in the Fitness app.
`;
}

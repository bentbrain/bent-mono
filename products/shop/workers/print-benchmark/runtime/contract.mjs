import { protectedConfig } from "../../../scripts/protected-config.mjs";
export const ACCOUNT = protectedConfig("awsAccountId");
export const REGION = 'ap-southeast-2';
export const FUNCTION = 'forever-tee-print-benchmark-development';
export const FUNCTION_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FUNCTION}`;
export const BUCKET = `forever-tee-video-development-${ACCOUNT}-${REGION}`;
export const PREFIX = 'source/print-benchmark/';
export const CI_ROLE = `${FUNCTION}-ci`;
export const RUNTIME_ROLE = `${FUNCTION}-runtime`;
export const check = (ok, message) => { if (!ok)
    throw new Error(`Print benchmark rejected: ${message}`); };
export function validateInvocation(event, fixtures) {
    check(event && JSON.stringify(Object.keys(event).sort()) === JSON.stringify(['fixture', 'invocation', 'runId']), 'exact event fields');
    check(/^[1-9][0-9]{0,19}$/.test(event.runId ?? '') && /^[a-f0-9]{32}$/.test(event.invocation ?? ''), 'isolated run and invocation');
    const fixture = fixtures.find(item => item.name === event.fixture);
    check(fixture && /^[a-f0-9]{64}$/.test(fixture.sha256), 'approved fixture');
    check(Number.isSafeInteger(fixture.bytes) && fixture.bytes > 0 && fixture.bytes <= 25000000, 'source byte budget');
    check(fixture.plans.length === 3 && fixture.plans.every(plan => Number.isSafeInteger(plan.width) && plan.width > 0 && plan.width <= 5000 &&
        Number.isSafeInteger(plan.height) && plan.height > 0 && plan.height <= 5500 &&
        plan.layers.length === 6 && plan.layers.every(layer => {
        const keys = ['width', 'height', 'trimLeft', 'trimRight', 'trimTop', 'trimBottom', 'destinationLeft', 'destinationTop'];
        return keys.every(key => Number.isSafeInteger(layer[key]) && layer[key] >= 0) &&
            layer.width > 0 && layer.width <= 12000 && layer.height > 0 && layer.height <= 12000 &&
            layer.width > layer.trimLeft + layer.trimRight && layer.height > layer.trimTop + layer.trimBottom &&
            layer.destinationLeft + layer.width - layer.trimLeft - layer.trimRight <= plan.width &&
            layer.destinationTop + layer.height - layer.trimTop - layer.trimBottom <= plan.height;
    })), 'bounded immutable pixel plans');
    return { fixture, sourceKey: `${PREFIX}${event.runId}/inputs/${fixture.sha256}.png`,
        outputPrefix: `${PREFIX}${event.runId}/outputs/${event.invocation}/` };
}
export function assertRuntime(env, context) {
    check(context?.invokedFunctionArn === FUNCTION_ARN && env.AWS_LAMBDA_FUNCTION_NAME === FUNCTION &&
        env.AWS_REGION === REGION && env.AWS_EXECUTION_ENV === 'AWS_Lambda_nodejs24.x' &&
        ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'].every(key => typeof env[key] === 'string' && env[key].length > 0), 'exact personal Lambda and explicit execution credentials');
}

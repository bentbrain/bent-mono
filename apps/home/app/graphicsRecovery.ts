/** A renderer may restart twice; repeated failures must not become a reload loop. */
export const MAX_GRAPHICS_RECOVERIES=2;
export const CONTEXT_RECOVERY_TIMEOUT_MS=5000;
export interface GraphicsRuntimeOptions {
 disableVertexArrayObjects?:boolean;
 onRenderError?:(error:unknown)=>void;
}

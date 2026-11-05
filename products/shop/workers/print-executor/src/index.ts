// This Worker owns the print namespace so its creation never crosses the API
// Worker's immutable-version rollback boundary. There is no public HTTP API.
export { PrintAssetExecution } from "../../api/src/print-execution-object";

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};

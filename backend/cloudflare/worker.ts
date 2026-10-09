export { DraftOffRoom } from './room';
import { handleHttp, type HttpEnv } from './http';
export default { fetch(request: Request, env: HttpEnv) { return handleHttp(request, env); } };

import { checkinHandler } from '../../lib/http/checkin.mjs';

export default checkinHandler();
export const config = { schedule: '0 6 * * *' };

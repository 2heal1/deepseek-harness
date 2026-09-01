import { clientBundle } from '../tsdown.client.ts'

/** Build the Host bridge and its dynamic browser loader. */
export default clientBundle('@deepseek-ai/dsh-client-remote-bundles', ['lib/types/index.js', 'lib/types/invariant.js'])

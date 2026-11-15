import { currentProvider, type RecognizerConfig } from './provider-context.js';

/** Only the companion's isolated upstream command resolves this factory. */
export const createSttEngine = (config: RecognizerConfig) => currentProvider().engine(config);

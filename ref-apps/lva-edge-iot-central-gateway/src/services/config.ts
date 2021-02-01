import { service } from 'spryly';
import * as nconf from 'nconf';

@service('config')
export class ConfigService {
    private config: nconf.Provider;

    public async init(): Promise<void> {
        this.config = nconf.env().file(`./configs/${process.env.NODE_ENV}.json`);
    }

    public get(key: string): any {
        return this.config.get(key);
    }
}

import plugin from '../../../lib/plugins/plugin.js'
import { getProductionYunzaiAgent } from '../dist/runtime/production-yunzai-agent.js'

export class bym extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin 伪人bym',
      dsc: 'bym',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^[^#][sS]*',
          fnc: 'bym',
          priority: '-1000000',
          log: false
        }
      ]
    })
  }

  async bym (event) {
    return await getProductionYunzaiAgent().bymController.bym(event)
  }
}

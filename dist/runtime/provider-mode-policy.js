export const unsupportedProviderMessage = '该模型模式已不再支持，GroupMate 当前仅支持 OpenAI-compatible API';
const directProviderCommand = String.raw `#(?:图片)?(?:chat3|api3|chatglm|glm4|bing|claude(?:2|3|\.ai)?|xh|qwen|gemini)[sS]*(?![a-z0-9])`;
const xinghuoCommand = String.raw `#星火(?:(?:搜索|查找)?助手)`;
const providerSwitchCommand = String.raw `#chatgpt切换(?:api3|browser|浏览器|必应|bing|copilot|claude(?:2|\.ai)?|gemini|星火|azure|通义千问|qwen|千问|智谱(?:清言)?|chatglm4?)`;
const providerTokenCommand = String.raw `#chatgpt(?:(?:设置|绑定|删除|解绑)(?:token)|(?:设置|绑定)(?:poe)(?:token)|(?:设置|绑定|添加|删除|移除|查看|浏览|迁移|恢复)(?:必应|bing)\s*(?:token))`;
const providerSettingCommand = String.raw `#chatgpt(?:(?:设置|查看)(?:bing|必应|sydney|悉尼|claude|gemini|星火|qwen|通义千问)设定|设置(?:claude|gemini|星火|qwen|通义千问|chatglm4?)(?:key|token|模型))`;
const bingManagementCommand = String.raw `#chatgpt(?:(?:必应|bing)切换|(?:必应|bing)(?:(?:开启|关闭)建议(?:回复)?|(?:开启|关闭|启用|禁用|禁止)搜索)|(?:copilot|bing|必应)配置方法)`;
const geminiManagementCommand = String.raw `#chatgpt(?:开启|关闭)gemini(?:搜索|代码执行)`;
const providerTranslationCommand = String.raw `#(?:chatgpt)?(?:设置|修改)翻译来源(?:gemini|星火|通义千问|xh|qwen)`;
export const legacyProviderCommandPattern = new RegExp(`^(?:${[
    directProviderCommand,
    xinghuoCommand,
    providerSwitchCommand,
    providerTokenCommand,
    providerSettingCommand,
    bingManagementCommand,
    geminiManagementCommand,
    providerTranslationCommand
].join('|')})`, 'i');
export function resolveProviderMode(value) {
    if (value === undefined || value === null) {
        return { mode: 'api', migrated: false };
    }
    if (typeof value === 'string' &&
        (value === '' || value === 'default' || value === 'api')) {
        return { mode: 'api', migrated: false };
    }
    return { mode: 'api', migrated: true };
}

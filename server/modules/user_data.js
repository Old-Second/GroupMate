let users = {
    user: []
}
export const UserData = new Proxy(users, {
    set(target, property, value) {
        target[property] = value
        return true
    }
})
// 获取用户信息
export function UserInfo(token) {
    const userData = users.user.find(user => user.token.includes(token))
    if (userData) {
        return {
            user: userData.user,
            autho: userData.autho,
            label: userData.label
        }
    } else {
        return undefined
    }
}
// 获取用户数据
export function GetUser(user) {
    return users.user.find(item => String(item.user) === String(user))
}
// 添加用户token
export async function AddUser(data) {
    const sameUser = users.user.filter(item => String(item.user) === String(data.user))
    if (sameUser.length > 0) {
        const record = sameUser[0]
        // 旧实现每次登录都追加一条记录，历史重复记录会让按 token 查到的权限和按
        // 账号查到的权限不一致，借本次登录把同一账号的记录合并掉
        record.token = [...new Set(sameUser.flatMap(item => item.token).concat(data.token))]
        // 登录时重新核验过身份，权限以本次结果为准，避免旧记录留着已经失效的 admin
        record.autho = data.autho
        if (data.label) {
            record.label = data.label
        }
        users.user = users.user.filter(item => item === record || !sameUser.includes(item))
    } else {
        users.user.push({
            user: data.user,
            autho: data.autho,
            token: [data.token],
            label: data.label || '',
            tiem: new Date()
        })
    }
    await redis.set('CHATGPT:SERVER_USER', JSON.stringify(users))
}
export async function ReplaceUsers() {
    users = JSON.parse(await redis.get('CHATGPT:SERVER_USER') || '{"user": []}')
}
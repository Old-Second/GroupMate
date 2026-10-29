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
    const userIndex = users.user.findIndex(item => String(item.user) === String(data.user))
    if (userIndex >= 0) {
        if (!users.user[userIndex].token.includes(data.token)) {
            users.user[userIndex].token.push(data.token)
        }
        // 登录时重新核验过身份，权限以本次结果为准，避免旧记录留着已经失效的 admin
        users.user[userIndex].autho = data.autho
        if (data.label) {
            users.user[userIndex].label = data.label
        }
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
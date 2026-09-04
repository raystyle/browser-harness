# Cookies

操作附加页面/上下文范围内的 cookie 用 `Network.*`；操作浏览器中的全部 cookie 用 `Storage.getCookies` / `Storage.setCookies`。

## 读取

```js
await session.Network.enable({})

// All cookies visible to the attached page (current origin + its frames)
const { cookies } = await session.Network.getCookies({})

// Cookies for specific URLs
const { cookies: github } = await session.Network.getCookies({
  urls: ['https://github.com/'],
})

// Every cookie across the whole browser (requires Storage domain)
const { cookies: all } = await session.Storage.getCookies({})
```

字段结构：`{ name, value, domain, path, expires, size, httpOnly, secure, session, sameSite?, sourceScheme?, priority? }`。

## 写入

```js
// Single cookie on the attached page
await session.Network.setCookie({
  name: 'session',
  value: 'abc123',
  domain: '.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  expires: Date.now() / 1000 + 86400,   // seconds since epoch
})

// Bulk import (e.g. to preload an auth session)
await session.Network.setCookies({
  cookies: [
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: '.example.com', path: '/' },
  ],
})
```

## 删除 / 清空

```js
await session.Network.deleteCookies({ name: 'session', domain: '.example.com' })
await session.Network.clearBrowserCookies()   // nukes everything in the default context
```

## 注意事项

- 如果 `domain` 与当前 profile 中任何 origin 都不匹配，`Network.setCookie` 会静默失败且不报错——你仍会拿到 `{ success: true }`，但 cookie 根本没写入。之后请用 `getCookies` 验证。
- `expires` 是秒（浮点数），**不是**毫秒。这是常见错误。
- 会话 cookie：不传 `expires`，Chrome 会将其视为会话级。设置 `expires: 0` 同样有效。
- `sameSite` 取值为 `'Strict'` | `'Lax'` | `'None'`。使用 `'None'` 时，Chrome 还要求 `secure: true`。
- 清除 cookie 并不会清除 localStorage/IndexedDB。要完全登出，还需调用 `Storage.clearDataForOrigin({ origin, storageTypes: 'all' })`。

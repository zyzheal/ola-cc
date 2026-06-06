/**
 * BackendResolver.test.ts — Phase 6c-2: NestJS + Express + Java framework resolver tests
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { nestjsResolver } from '../resolution/frameworks/nestjs.js'
import { expressResolver } from '../resolution/frameworks/express.js'
import { javaResolver } from '../resolution/frameworks/java.js'
import {
  registerFrameworkResolver,
  resetFrameworkResolvers,
  getAllFrameworkResolvers,
} from '../resolution/frameworks/index.js'
import type { ResolutionContext, UnresolvedRef, FrameworkExtractionResult } from '../resolution/types.js'
import type { NodeMetadata } from '../GraphStore.js'

// ============================================================
// Test helpers
// ============================================================

function makeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  }
}

function makeRef(overrides: Partial<UnresolvedRef> = {}): UnresolvedRef {
  return {
    fromNodeId: 'node-1',
    referenceName: 'Foo',
    referenceKind: 'calls',
    line: 10,
    column: 0,
    filePath: 'src/app.ts',
    language: 'typescript',
    ...overrides,
  }
}

// ============================================================
// NestJS Resolver
// ============================================================

describe('NestJS Resolver', () => {
  describe('detect', () => {
    it('detects @nestjs/core in package.json dependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ dependencies: { '@nestjs/core': '^10.0.0' } })
          }
          return null
        },
      })
      expect(nestjsResolver.detect(ctx)).toBe(true)
    })

    it('detects @nestjs/common in devDependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ devDependencies: { '@nestjs/common': '^10.0.0' } })
          }
          return null
        },
      })
      expect(nestjsResolver.detect(ctx)).toBe(true)
    })

    it('detects NestJS by .controller.ts files with @Controller', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'src/user.controller.ts') return '@Controller("users") class UserController {}'
          return null
        },
        getAllFiles: () => ['src/user.controller.ts'],
      })
      expect(nestjsResolver.detect(ctx)).toBe(true)
    })

    it('detects NestJS by .module.ts files with @Module', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'src/app.module.ts') return '@Module({}) class AppModule {}'
          return null
        },
        getAllFiles: () => ['src/app.module.ts'],
      })
      expect(nestjsResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no NestJS indicators', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') return JSON.stringify({ dependencies: { express: '^4.0.0' } })
          return null
        },
        getAllFiles: () => ['src/app.ts'],
      })
      expect(nestjsResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves *Service references with .service. convention', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UsersService') {
            return [{ id: 'svc-1', name: 'UsersService', kind: 'class', file: 'src/users.service.ts', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UsersService' })
      const result = nestjsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('svc-1')
      expect(result!.confidence).toBe(0.85)
      expect(result!.resolvedBy).toBe('framework')
    })

    it('resolves *Controller references with .controller. convention', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserController') {
            return [{ id: 'ctrl-1', name: 'UserController', kind: 'class', file: 'src/user.controller.ts', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserController' })
      const result = nestjsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('ctrl-1')
    })

    it('resolves *Guard references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'AuthGuard') {
            return [{ id: 'guard-1', name: 'AuthGuard', kind: 'class', file: 'src/auth.guard.ts', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'AuthGuard' })
      const result = nestjsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('guard-1')
    })

    it('returns lower confidence when convention not matched', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UsersService') {
            return [{ id: 'svc-2', name: 'UsersService', kind: 'class', file: 'src/misc.ts', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UsersService' })
      const result = nestjsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.7)
    })

    it('returns null for non-NestJS patterns', () => {
      const ref = makeRef({ referenceName: 'someRandomThing' })
      const result = nestjsResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts HTTP routes from @Get decorator', () => {
      const content = `
@Controller('users')
class UserController {
  @Get()
  findAll() {}

  @Get(':id')
  findOne() {}
}
`
      const result = nestjsResolver.extract!('src/user.controller.ts', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.kind).toBe('route')
      expect(result.nodes[0]!.name).toBe('GET /users')
      expect(result.nodes[1]!.name).toBe('GET /users/:id')
    })

    it('extracts POST routes', () => {
      const content = `
@Controller('items')
class ItemController {
  @Post()
  create() {}
}
`
      const result = nestjsResolver.extract!('src/item.controller.ts', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('POST /items')
    })

    it('extracts routes with handler references', () => {
      const content = `
@Controller('users')
class UserController {
  @Get()
  findAll() {}
}
`
      const result = nestjsResolver.extract!('src/user.controller.ts', content)
      expect(result.nodes.length).toBe(1)
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('findAll')
    })

    it('extracts GraphQL operations inside @Resolver', () => {
      const content = `
@Resolver('User')
class UserResolver {
  @Query('users')
  findAll() {}

  @Mutation('createUser')
  create() {}
}
`
      const result = nestjsResolver.extract!('src/user.resolver.ts', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('QUERY users')
      expect(result.nodes[1]!.name).toBe('MUTATION createUser')
    })

    it('ignores @Query inside @Controller (REST param decorator)', () => {
      const content = `
@Controller('users')
class UserController {
  @Get()
  findAll(@Query('page') page: number) {}
}
`
      const result = nestjsResolver.extract!('src/user.controller.ts', content)
      // Only the @Get route, not the @Query param decorator
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('GET /users')
    })

    it('extracts microservice message patterns', () => {
      const content = `
class MathController {
  @MessagePattern('sum')
  sum() {}

  @EventPattern('user.created')
  onUserCreated() {}
}
`
      const result = nestjsResolver.extract!('src/math.controller.ts', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('MESSAGE sum')
      expect(result.nodes[1]!.name).toBe('EVENT user.created')
    })

    it('extracts WebSocket handlers', () => {
      const content = `
@WebSocketGateway({ namespace: 'chat' })
class ChatGateway {
  @SubscribeMessage('message')
  handleMessage() {}
}
`
      const result = nestjsResolver.extract!('src/chat.gateway.ts', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('WS chat:message')
    })

    it('returns empty for non-JS files', () => {
      const result = nestjsResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
      expect(result.references.length).toBe(0)
    })
  })
})

// ============================================================
// Express Resolver
// ============================================================

describe('Express Resolver', () => {
  describe('detect', () => {
    it('detects express in package.json dependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ dependencies: { express: '^4.18.0' } })
          }
          return null
        },
      })
      expect(expressResolver.detect(ctx)).toBe(true)
    })

    it('detects fastify in dependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ dependencies: { fastify: '^4.0.0' } })
          }
          return null
        },
      })
      expect(expressResolver.detect(ctx)).toBe(true)
    })

    it('detects Express by routes directory with app.get', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'routes/users.js') return "app.get('/users', handler)"
          return null
        },
        getAllFiles: () => ['routes/users.js'],
      })
      expect(expressResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no Express indicators', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') return JSON.stringify({ dependencies: { react: '^18.0.0' } })
          return null
        },
        getAllFiles: () => ['src/App.tsx'],
      })
      expect(expressResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves middleware by name (auth)', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'auth') {
            return [{ id: 'mw-1', name: 'auth', kind: 'function', file: 'middleware/auth.js', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'auth' })
      const result = expressResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('mw-1')
      expect(result!.confidence).toBe(0.8)
    })

    it('resolves middleware with Middleware suffix', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'authMiddleware') {
            return [{ id: 'mw-2', name: 'authMiddleware', kind: 'function', file: 'middleware/auth.js', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'authMiddleware' })
      const result = expressResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('mw-2')
    })

    it('resolves controller method references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'getUsers') {
            return [{ id: 'fn-1', name: 'getUsers', kind: 'function', file: 'controllers/userController.js', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserController.getUsers' })
      const result = expressResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('fn-1')
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves service method references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'fetchData') {
            return [{ id: 'fn-2', name: 'fetchData', kind: 'function', file: 'services/dataService.js', line: 10 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'DataService.fetchData' })
      const result = expressResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('fn-2')
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing' })
      const result = expressResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts app.get routes', () => {
      const content = `
const app = express();
app.get('/users', getUsers);
app.post('/users', createUser);
`
      const result = expressResolver.extract!('src/app.js', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.kind).toBe('route')
      expect(result.nodes[0]!.name).toBe('GET /users')
      expect(result.nodes[1]!.name).toBe('POST /users')
    })

    it('extracts router routes', () => {
      const content = `
const router = express.Router();
router.get('/items', getItems);
router.delete('/items/:id', deleteItem);
`
      const result = expressResolver.extract!('routes/items.js', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('GET /items')
      expect(result.nodes[1]!.name).toBe('DELETE /items/:id')
    })

    it('extracts named handler references', () => {
      const content = `app.get('/users', getUsers);`
      const result = expressResolver.extract!('src/app.js', content)
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('getUsers')
    })

    it('extracts inline arrow handler calls', () => {
      const content = `app.get('/users', async (req, res) => { const data = fetchUsers(); res.json(data); });`
      const result = expressResolver.extract!('src/app.js', content)
      expect(result.nodes.length).toBe(1)
      // fetchUsers should be extracted as a call reference
      expect(result.references.some((r) => r.referenceName === 'fetchUsers')).toBe(true)
    })

    it('skips app.use without path prefix', () => {
      const content = `app.use(cors());`
      const result = expressResolver.extract!('src/app.js', content)
      expect(result.nodes.length).toBe(0)
    })

    it('extracts app.use with path', () => {
      const content = `app.use('/api', apiRouter);`
      const result = expressResolver.extract!('src/app.js', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('USE /api')
    })

    it('returns empty for non-JS files', () => {
      const result = expressResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
    })

    it('filters out reserved calls in inline handlers', () => {
      const content = `app.get('/test', (req, res) => { res.json({ ok: true }); log('test'); });`
      const result = expressResolver.extract!('src/app.js', content)
      // res.json and log are reserved, should not appear as references
      const refNames = result.references.map((r) => r.referenceName)
      expect(refNames).not.toContain('json')
      expect(refNames).not.toContain('log')
    })
  })
})

// ============================================================
// Java/Spring Resolver
// ============================================================

describe('Java/Spring Resolver', () => {
  describe('detect', () => {
    it('detects spring-boot in pom.xml', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'pom.xml') return '<dependency><groupId>org.springframework.boot</groupId></dependency>'
          return null
        },
      })
      expect(javaResolver.detect(ctx)).toBe(true)
    })

    it('detects spring-boot in build.gradle', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'build.gradle') return "implementation 'org.springframework.boot:spring-boot-starter'"
          return null
        },
      })
      expect(javaResolver.detect(ctx)).toBe(true)
    })

    it('detects spring-boot in build.gradle.kts', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'build.gradle.kts') return 'implementation("org.springframework.boot:spring-boot-starter")'
          return null
        },
      })
      expect(javaResolver.detect(ctx)).toBe(true)
    })

    it('detects Spring by @RestController in Java files', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'src/main/java/UserController.java') return '@RestController public class UserController {}'
          return null
        },
        getAllFiles: () => ['src/main/java/UserController.java'],
      })
      expect(javaResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no Spring indicators', () => {
      const ctx = makeContext({
        readFile: () => null,
        getAllFiles: () => [],
      })
      expect(javaResolver.detect(ctx)).toBe(false)
    })
  })

  describe('claimsReference', () => {
    it('claims :prefix suffixed names', () => {
      expect(javaResolver.claimsReference!('app.cache:prefix')).toBe(true)
    })

    it('does not claim normal names', () => {
      expect(javaResolver.claimsReference!('UserService')).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves *Service references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserService') {
            return [{ id: 'svc-1', name: 'UserService', kind: 'class', file: 'src/main/java/service/UserService.java', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserService', language: 'java' })
      const result = javaResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('svc-1')
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves *Repository references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserRepository') {
            return [{ id: 'repo-1', name: 'UserRepository', kind: 'interface', file: 'src/main/java/repository/UserRepository.java', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserRepository', language: 'java' })
      const result = javaResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('repo-1')
    })

    it('resolves *Controller references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserController') {
            return [{ id: 'ctrl-1', name: 'UserController', kind: 'class', file: 'src/main/java/controller/UserController.java', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserController', language: 'java' })
      const result = javaResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('ctrl-1')
    })

    it('resolves Spring config key references', () => {
      const ctx = makeContext({
        getNodesByKind: (kind) => {
          if (kind === 'constant') {
            return [
              { id: 'cfg-1', name: 'timeout', kind: 'constant', file: 'application.yml', line: 5, language: 'yaml', qualified_name: 'app.cache.timeout' },
            ]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'app.cache.timeout', language: 'java' })
      const result = javaResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('cfg-1')
      expect(result!.confidence).toBe(0.9)
    })

    it('resolves :prefix references to config subtree', () => {
      const ctx = makeContext({
        getNodesByKind: (kind) => {
          if (kind === 'constant') {
            return [
              { id: 'cfg-1', name: 'timeout', kind: 'constant', file: 'application.yml', line: 5, language: 'yaml', qualified_name: 'app.cache.timeout' },
              { id: 'cfg-2', name: 'name', kind: 'constant', file: 'application.yml', line: 6, language: 'yaml', qualified_name: 'app.cache.name.user-token' },
            ]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'app.cache:prefix', language: 'java' })
      const result = javaResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      // Should pick shortest match (app.cache.timeout over app.cache.name.user-token)
      expect(result!.targetNodeId).toBe('cfg-1')
    })

    it('resolves PascalCase entity references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'User') {
            return [{ id: 'entity-1', name: 'User', kind: 'class', file: 'src/main/java/entity/User.java', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'User', language: 'java' })
      const result = javaResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('entity-1')
      expect(result!.confidence).toBe(0.7)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', language: 'java' })
      const result = javaResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts Spring config from application.yml', () => {
      const content = `
app:
  cache:
    timeout: 30
    enabled: true
server:
  port: 8080
`
      const result = javaResolver.extract!('application.yml', content)
      expect(result.nodes.length).toBe(3)
      const names = result.nodes.map((n) => n.qualified_name)
      expect(names).toContain('app.cache.timeout')
      expect(names).toContain('app.cache.enabled')
      expect(names).toContain('server.port')
    })

    it('extracts Spring config from application.properties', () => {
      const content = `
app.cache.timeout=30
server.port=8080
# comment line
`
      const result = javaResolver.extract!('application.properties', content)
      expect(result.nodes.length).toBe(2)
      const names = result.nodes.map((n) => n.qualified_name)
      expect(names).toContain('app.cache.timeout')
      expect(names).toContain('server.port')
    })

    it('extracts @GetMapping routes from Java', () => {
      const content = `
@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) { return null; }

    @PostMapping
    public User createUser(@RequestBody User user) { return null; }
}
`
      const result = javaResolver.extract!('UserController.java', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('GET /api/users/{id}')
      expect(result.nodes[1]!.name).toBe('POST /api/users')
    })

    it('extracts @RequestMapping with method attribute', () => {
      const content = `
@RestController
public class ItemController {
    @RequestMapping(value = "/items", method = RequestMethod.GET)
    public List<Item> getItems() { return null; }
}
`
      const result = javaResolver.extract!('ItemController.java', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('GET /items')
    })

    it('extracts @Value bindings', () => {
      const content = `
public class Config {
    @Value("\${app.name}")
    private String appName;
}
`
      const result = javaResolver.extract!('Config.java', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.kind).toBe('constant')
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('app.name')
    })

    it('extracts @ConfigurationProperties bindings', () => {
      const content = `
@ConfigurationProperties(prefix = "app.cache")
public class CacheProperties { }
`
      const result = javaResolver.extract!('CacheProperties.java', content)
      expect(result.nodes.length).toBe(1)
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('app.cache:prefix')
    })

    it('extracts Kotlin routes', () => {
      const content = `
@RestController
@RequestMapping("/api/items")
class ItemController {
    @GetMapping("/{id}")
    fun getItem(@PathVariable id: Long): Item? = null
}
`
      const result = javaResolver.extract!('ItemController.kt', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('GET /api/items/{id}')
    })

    it('returns empty for non-Java/Kotlin/YAML files', () => {
      const result = javaResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
    })

    it('returns empty for Java file with no annotations', () => {
      const result = javaResolver.extract!('Utils.java', 'public class Utils { public void helper() {} }')
      expect(result.nodes.length).toBe(0)
    })
  })
})

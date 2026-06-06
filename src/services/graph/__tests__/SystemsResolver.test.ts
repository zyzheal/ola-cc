/**
 * SystemsResolver.test.ts — Phase 6c-3: Go + Rust + Cargo + C# + Swift + Swift-ObjC framework resolver tests
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { goResolver } from '../resolution/frameworks/go.js'
import { rustResolver } from '../resolution/frameworks/rust.js'
import { getCargoWorkspaceCrateMap } from '../resolution/frameworks/cargo-workspace.js'
import { aspnetResolver } from '../resolution/frameworks/csharp.js'
import { swiftUIResolver, uikitResolver, vaporResolver } from '../resolution/frameworks/swift.js'
import { swiftObjcBridgeResolver } from '../resolution/frameworks/swift-objc.js'
import {
  registerFrameworkResolver,
  resetFrameworkResolvers,
  getAllFrameworkResolvers,
} from '../resolution/frameworks/index.js'
import type { ResolutionContext, UnresolvedRef } from '../resolution/types.js'
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
    filePath: 'src/app.go',
    language: 'go',
    ...overrides,
  }
}

// ============================================================
// Go Resolver
// ============================================================

describe('Go Resolver', () => {
  describe('detect', () => {
    it('detects Go by go.mod', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'go.mod') return 'module example.com/myapp\n\ngo 1.21\n'
          return null
        },
      })
      expect(goResolver.detect(ctx)).toBe(true)
    })

    it('detects Go by .go files', () => {
      const ctx = makeContext({
        getAllFiles: () => ['main.go', 'handler/user.go'],
      })
      expect(goResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no Go indicators', () => {
      const ctx = makeContext({
        readFile: () => null,
        getAllFiles: () => ['src/app.ts'],
      })
      expect(goResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves Handler references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserHandler') {
            return [{ id: 'h-1', name: 'UserHandler', kind: 'function', file: 'handler/user.go', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserHandler', language: 'go' })
      const result = goResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('h-1')
      expect(result!.confidence).toBe(0.8)
      expect(result!.resolvedBy).toBe('framework')
    })

    it('resolves Handle* references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'HandleUser') {
            return [{ id: 'h-2', name: 'HandleUser', kind: 'function', file: 'api/user.go', line: 10 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'HandleUser', language: 'go' })
      const result = goResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('h-2')
    })

    it('resolves Service references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserService') {
            return [{ id: 'svc-1', name: 'UserService', kind: 'struct', file: 'service/user.go', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserService', language: 'go' })
      const result = goResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('svc-1')
    })

    it('resolves Middleware references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'AuthMiddleware') {
            return [{ id: 'mw-1', name: 'AuthMiddleware', kind: 'function', file: 'middleware/auth.go', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'AuthMiddleware', language: 'go' })
      const result = goResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.75)
    })

    it('resolves PascalCase struct references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserProfile') {
            return [{ id: 'struct-1', name: 'UserProfile', kind: 'struct', file: 'model/user.go', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserProfile', language: 'go' })
      const result = goResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.7)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', language: 'go' })
      const result = goResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts Gin GET routes', () => {
      const content = `package main

import "github.com/gin-gonic/gin"

func main() {
  r := gin.Default()
  r.GET("/users", getUsers)
  r.POST("/users", createUser)
}
`
      const result = goResolver.extract!('main.go', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.kind).toBe('route')
      expect(result.nodes[0]!.name).toBe('GET /users')
      expect(result.nodes[1]!.name).toBe('POST /users')
    })

    it('extracts handler references', () => {
      const content = `r.GET("/users", getUsers)`
      const result = goResolver.extract!('main.go', content)
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('getUsers')
    })

    it('extracts net/http HandleFunc routes', () => {
      const content = `mux.HandleFunc("/api/users", userHandler)`
      const result = goResolver.extract!('main.go', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('ANY /api/users')
    })

    it('extracts Chi routes', () => {
      const content = `r.Get("/items", getItems)
r.Post("/items", createItem)`
      const result = goResolver.extract!('main.go', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('GET /items')
      expect(result.nodes[1]!.name).toBe('POST /items')
    })

    it('extracts group var routes (v1.GET)', () => {
      const content = `v1 := r.Group("/api/v1")
v1.GET("/users", listUsers)`
      const result = goResolver.extract!('main.go', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('GET /users')
    })

    it('extracts dotted handler names', () => {
      const content = `r.GET("/users", user.List)`
      const result = goResolver.extract!('main.go', content)
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('List')
    })

    it('returns empty for non-.go files', () => {
      const result = goResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
      expect(result.references.length).toBe(0)
    })

    it('returns empty for .go file with no routes', () => {
      const result = goResolver.extract!('util.go', 'package util\nfunc Helper() {}')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Rust Resolver
// ============================================================

describe('Rust Resolver', () => {
  describe('detect', () => {
    it('detects Rust by Cargo.toml', () => {
      const ctx = makeContext({
        fileExists: (path) => path === 'Cargo.toml',
      })
      expect(rustResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no Cargo.toml', () => {
      const ctx = makeContext({ fileExists: () => false })
      expect(rustResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves *_handler references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'get_user_handler') {
            return [{ id: 'fn-1', name: 'get_user_handler', kind: 'function', file: 'src/handlers/user.rs', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'get_user_handler', language: 'rust' })
      const result = rustResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('fn-1')
      expect(result!.confidence).toBe(0.8)
    })

    it('resolves handle_* references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'handle_request') {
            return [{ id: 'fn-2', name: 'handle_request', kind: 'function', file: 'src/api/mod.rs', line: 10 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'handle_request', language: 'rust' })
      const result = rustResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('fn-2')
    })

    it('resolves *Service struct references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserService') {
            return [{ id: 'struct-1', name: 'UserService', kind: 'struct', file: 'src/services/user.rs', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserService', language: 'rust' })
      const result = rustResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.8)
    })

    it('resolves PascalCase struct references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserProfile') {
            return [{ id: 'struct-2', name: 'UserProfile', kind: 'struct', file: 'src/models/user.rs', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserProfile', language: 'rust' })
      const result = rustResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.7)
    })

    it('resolves module references by local path', () => {
      const ctx = makeContext({
        fileExists: (path) => path === 'src/user.rs',
        getNodesInFile: (path) => {
          if (path === 'src/user.rs') {
            return [{ id: 'mod-1', name: 'user', kind: 'module', file: 'src/user.rs', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'user', language: 'rust' })
      const result = rustResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.6)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', language: 'rust' })
      const result = rustResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts Actix #[get] route attribute', () => {
      const content = `use actix_web::{get, HttpResponse};

#[get("/users")]
async fn get_users() -> HttpResponse {
    HttpResponse::Ok().finish()
}
`
      const result = rustResolver.extract!('src/main.rs', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.kind).toBe('route')
      expect(result.nodes[0]!.name).toBe('GET /users')
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('get_users')
    })

    it('extracts Rocket #[post] route', () => {
      const content = `#[post("/items", data = "<item>")]
async fn create_item(item: String) -> &'static str {
    "created"
}
`
      const result = rustResolver.extract!('src/main.rs', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('POST /items')
    })

    it('extracts Axum .route() with get/post', () => {
      const content = `let app = Router::new()
    .route("/users", get(list_users).post(create_user));`
      const result = rustResolver.extract!('src/main.rs', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('GET /users')
      expect(result.nodes[1]!.name).toBe('POST /users')
    })

    it('extracts Actix web::resource routes', () => {
      const content = `App::new()
    .service(web::resource("/items").route(web::get().to(list_items)))`
      const result = rustResolver.extract!('src/main.rs', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('GET /items')
      expect(result.references[0]!.referenceName).toBe('list_items')
    })

    it('extracts Actix .route() builder API', () => {
      const content = `App::new()
    .route("/users", web::get().to(get_users))
    .route("/users", web::post().to(create_user))`
      const result = rustResolver.extract!('src/main.rs', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('GET /users')
      expect(result.nodes[1]!.name).toBe('POST /users')
    })

    it('handles namespaced Axum handlers', () => {
      const content = `.route("/items", get(module::list_items))`
      const result = rustResolver.extract!('src/main.rs', content)
      expect(result.references[0]!.referenceName).toBe('list_items')
    })

    it('returns empty for non-.rs files', () => {
      const result = rustResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
    })

    it('returns empty for .rs file with no routes', () => {
      const result = rustResolver.extract!('src/lib.rs', 'fn helper() {}')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Cargo Workspace Resolver
// ============================================================

describe('Cargo Workspace Resolver', () => {
  it('builds crate map from workspace Cargo.toml', () => {
    const ctx = makeContext({
      readFile: (path) => {
        if (path === 'Cargo.toml') {
          return `[workspace]\nmembers = ["crates/core", "crates/cli"]\n`
        }
        if (path === 'crates/core/Cargo.toml') {
          return `[package]\nname = "myapp-core"\nversion = "0.1.0"\n`
        }
        if (path === 'crates/cli/Cargo.toml') {
          return `[package]\nname = "myapp-cli"\nversion = "0.1.0"\n`
        }
        return null
      },
    })
    const map = getCargoWorkspaceCrateMap(ctx)
    expect(map.get('myapp-core')).toBe('crates/core')
    expect(map.get('myapp_core')).toBe('crates/core')
    expect(map.get('myapp-cli')).toBe('crates/cli')
    expect(map.get('myapp_cli')).toBe('crates/cli')
  })

  it('returns empty map when no Cargo.toml', () => {
    const ctx = makeContext({ readFile: () => null })
    const map = getCargoWorkspaceCrateMap(ctx)
    expect(map.size).toBe(0)
  })

  it('returns empty map when Cargo.toml has no workspace', () => {
    const ctx = makeContext({
      readFile: (path) => {
        if (path === 'Cargo.toml') return '[package]\nname = "single-crate"\n'
        return null
      },
    })
    const map = getCargoWorkspaceCrateMap(ctx)
    expect(map.size).toBe(0)
  })
})

// ============================================================
// C# / ASP.NET Resolver
// ============================================================

describe('ASP.NET Resolver', () => {
  describe('detect', () => {
    it('detects ASP.NET by .csproj with Microsoft.AspNetCore', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'MyApp.csproj') return '<Project Sdk="Microsoft.NET.Sdk.Web"><PackageReference Include="Microsoft.AspNetCore.App" /></Project>'
          return null
        },
        getAllFiles: () => ['MyApp.csproj'],
      })
      expect(aspnetResolver.detect(ctx)).toBe(true)
    })

    it('detects ASP.NET by Program.cs with WebApplication', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'Program.cs') return 'var app = WebApplication.CreateBuilder().Build();'
          return null
        },
        getAllFiles: () => ['Program.cs'],
      })
      expect(aspnetResolver.detect(ctx)).toBe(true)
    })

    it('detects ASP.NET by Startup.cs', () => {
      const ctx = makeContext({
        fileExists: (path) => path === 'Startup.cs',
        readFile: () => null,
        getAllFiles: () => [],
      })
      expect(aspnetResolver.detect(ctx)).toBe(true)
    })

    it('detects ASP.NET by controller files with attributes', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'Controllers/UserController.cs') return '[ApiController]\n[Route("api/[controller]")]\npublic class UserController : ControllerBase {}'
          return null
        },
        getAllFiles: () => ['Controllers/UserController.cs'],
      })
      expect(aspnetResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no ASP.NET indicators', () => {
      const ctx = makeContext({ readFile: () => null, getAllFiles: () => [] })
      expect(aspnetResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves *Controller references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserController') {
            return [{ id: 'ctrl-1', name: 'UserController', kind: 'class', file: 'Controllers/UserController.cs', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserController', language: 'csharp' })
      const result = aspnetResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('ctrl-1')
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves *Service references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserService') {
            return [{ id: 'svc-1', name: 'UserService', kind: 'class', file: 'Services/UserService.cs', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserService', language: 'csharp' })
      const result = aspnetResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves interface references (I*Service)', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'IUserService') {
            return [{ id: 'iface-1', name: 'IUserService', kind: 'interface', file: 'Services/IUserService.cs', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'IUserService', language: 'csharp' })
      const result = aspnetResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
    })

    it('resolves *Repository references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserRepository') {
            return [{ id: 'repo-1', name: 'UserRepository', kind: 'class', file: 'Repositories/UserRepository.cs', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserRepository', language: 'csharp' })
      const result = aspnetResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
    })

    it('resolves ViewModel references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserViewModel') {
            return [{ id: 'vm-1', name: 'UserViewModel', kind: 'class', file: 'ViewModels/UserViewModel.cs', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserViewModel', language: 'csharp' })
      const result = aspnetResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      // Matches PascalCase pattern (0.7) since it also starts with uppercase
      expect(result!.confidence).toBe(0.7)
    })

    it('resolves PascalCase entity references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'User') {
            return [{ id: 'entity-1', name: 'User', kind: 'class', file: 'Models/User.cs', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'User', language: 'csharp' })
      const result = aspnetResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.7)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', language: 'csharp' })
      const result = aspnetResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts [HttpGet] routes', () => {
      const content = `
[Route("api/[controller]")]
[ApiController]
public class UserController : ControllerBase {
    [HttpGet]
    public IActionResult GetAll() { return Ok(); }

    [HttpGet("{id}")]
    public IActionResult GetById(int id) { return Ok(); }
}
`
      const result = aspnetResolver.extract!('UserController.cs', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('GET /api/[controller]')
      expect(result.nodes[1]!.name).toBe('GET /api/[controller]/{id}')
    })

    it('extracts [HttpPost] routes', () => {
      const content = `
[Route("api/items")]
public class ItemController : ControllerBase {
    [HttpPost]
    public IActionResult Create() { return Ok(); }
}
`
      const result = aspnetResolver.extract!('ItemController.cs', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('POST /api/items')
    })

    it('extracts bare [HttpGet] (path on class)', () => {
      const content = `
[Route("api/users")]
public class UserController : ControllerBase {
    [HttpGet]
    public IActionResult GetAll() { return Ok(); }
}
`
      const result = aspnetResolver.extract!('UserController.cs', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('GET /api/users')
    })

    it('extracts Minimal API MapGet routes', () => {
      const content = `
var app = WebApplication.Create();
app.MapGet("/users", GetUsers);
app.MapPost("/users", CreateUser);
`
      const result = aspnetResolver.extract!('Program.cs', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('GET /users')
      expect(result.nodes[1]!.name).toBe('POST /users')
    })

    it('extracts handler references from Minimal API', () => {
      const content = `app.MapGet("/users", GetUsers);`
      const result = aspnetResolver.extract!('Program.cs', content)
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('GetUsers')
    })

    it('extracts method references from attribute routes', () => {
      const content = `
[HttpGet]
public IActionResult GetAll() { return Ok(); }
`
      const result = aspnetResolver.extract!('UserController.cs', content)
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('GetAll')
    })

    it('returns empty for non-.cs files', () => {
      const result = aspnetResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
    })

    it('returns empty for .cs file with no routes', () => {
      const result = aspnetResolver.extract!('Utils.cs', 'public class Utils { }')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// SwiftUI Resolver
// ============================================================

describe('SwiftUI Resolver', () => {
  describe('detect', () => {
    it('detects SwiftUI by import', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'ContentView.swift') return 'import SwiftUI\nstruct ContentView: View { var body: some View { Text("Hello") } }'
          return null
        },
        getAllFiles: () => ['ContentView.swift'],
      })
      expect(swiftUIResolver.detect(ctx)).toBe(true)
    })

    it('detects SwiftUI by .xcodeproj', () => {
      const ctx = makeContext({
        getAllFiles: () => ['MyApp.xcodeproj'],
      })
      expect(swiftUIResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no SwiftUI indicators', () => {
      const ctx = makeContext({
        readFile: () => null,
        getAllFiles: () => ['main.swift'],
      })
      expect(swiftUIResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves View references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'ContentView') {
            return [{ id: 'view-1', name: 'ContentView', kind: 'component', file: 'Views/ContentView.swift', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'ContentView', language: 'swift' })
      const result = swiftUIResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves ViewModel references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserViewModel') {
            return [{ id: 'vm-1', name: 'UserViewModel', kind: 'class', file: 'ViewModels/UserViewModel.swift', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserViewModel', language: 'swift' })
      const result = swiftUIResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves *Store references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserStore') {
            return [{ id: 'store-1', name: 'UserStore', kind: 'class', file: 'Stores/UserStore.swift', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserStore', language: 'swift' })
      const result = swiftUIResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
    })

    it('resolves PascalCase model references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserProfile') {
            return [{ id: 'model-1', name: 'UserProfile', kind: 'struct', file: 'Models/UserProfile.swift', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserProfile', language: 'swift' })
      const result = swiftUIResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.7)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', language: 'swift' })
      const result = swiftUIResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts SwiftUI View structs', () => {
      const content = `import SwiftUI

struct ContentView: View {
    var body: some View {
        Text("Hello")
    }
}

struct DetailView: View {
    var body: some View {
        Text("Detail")
    }
}
`
      const result = swiftUIResolver.extract!('ContentView.swift', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.kind).toBe('component')
      expect(result.nodes[0]!.name).toBe('ContentView')
      expect(result.nodes[1]!.name).toBe('DetailView')
    })

    it('extracts @main App entry point', () => {
      const content = `import SwiftUI

@main
struct MyApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`
      const result = swiftUIResolver.extract!('MyApp.swift', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.kind).toBe('class')
      expect(result.nodes[0]!.name).toBe('MyApp')
    })

    it('returns empty for non-.swift files', () => {
      const result = swiftUIResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// UIKit Resolver
// ============================================================

describe('UIKit Resolver', () => {
  describe('detect', () => {
    it('detects UIKit by import', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'ViewController.swift') return 'import UIKit\nclass ViewController: UIViewController {}'
          return null
        },
        getAllFiles: () => ['ViewController.swift'],
      })
      expect(uikitResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no UIKit indicators', () => {
      const ctx = makeContext({ readFile: () => null, getAllFiles: () => [] })
      expect(uikitResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves ViewController references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserViewController') {
            return [{ id: 'vc-1', name: 'UserViewController', kind: 'class', file: 'ViewControllers/UserViewController.swift', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserViewController', language: 'swift' })
      const result = uikitResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves UIView references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'CustomView') {
            return [{ id: 'view-1', name: 'CustomView', kind: 'class', file: 'Views/CustomView.swift', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'CustomView', language: 'swift' })
      const result = uikitResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.8)
    })

    it('resolves Cell references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserCell') {
            return [{ id: 'cell-1', name: 'UserCell', kind: 'class', file: 'Cells/UserCell.swift', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserCell', language: 'swift' })
      const result = uikitResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves Delegate references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserDelegate') {
            return [{ id: 'proto-1', name: 'UserDelegate', kind: 'protocol', file: 'Protocols/UserDelegate.swift', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserDelegate', language: 'swift' })
      const result = uikitResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.8)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', language: 'swift' })
      const result = uikitResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts UIViewController subclasses', () => {
      const content = `import UIKit

class UserViewController: UIViewController {
    override func viewDidLoad() { super.viewDidLoad() }
}
`
      const result = uikitResolver.extract!('UserViewController.swift', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.kind).toBe('class')
      expect(result.nodes[0]!.name).toBe('UserViewController')
    })

    it('extracts UIView subclasses', () => {
      const content = `import UIKit

class CustomView: UIView {
    override func layoutSubviews() { super.layoutSubviews() }
}
`
      const result = uikitResolver.extract!('CustomView.swift', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.name).toBe('CustomView')
    })

    it('does not extract UIViewController as UIView', () => {
      const content = `class MyViewController: UIViewController {}`
      const result = uikitResolver.extract!('MyViewController.swift', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.id).toContain('viewcontroller')
    })

    it('returns empty for non-.swift files', () => {
      const result = uikitResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Vapor Resolver
// ============================================================

describe('Vapor Resolver', () => {
  describe('detect', () => {
    it('detects Vapor by Package.swift', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'Package.swift') return '.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")'
          return null
        },
        getAllFiles: () => [],
      })
      expect(vaporResolver.detect(ctx)).toBe(true)
    })

    it('detects Vapor by import Vapor', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'Routes.swift') return 'import Vapor\nfunc routes(_ app: Application) throws {}'
          return null
        },
        getAllFiles: () => ['Routes.swift'],
      })
      expect(vaporResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no Vapor indicators', () => {
      const ctx = makeContext({ readFile: () => null, getAllFiles: () => [] })
      expect(vaporResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves Controller references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'UserController') {
            return [{ id: 'ctrl-1', name: 'UserController', kind: 'class', file: 'Controllers/UserController.swift', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'UserController', language: 'swift' })
      const result = vaporResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves Middleware references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'AuthMiddleware') {
            return [{ id: 'mw-1', name: 'AuthMiddleware', kind: 'class', file: 'Middleware/AuthMiddleware.swift', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'AuthMiddleware', language: 'swift' })
      const result = vaporResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.75)
    })

    it('resolves PascalCase Fluent model references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'User') {
            return [{ id: 'model-1', name: 'User', kind: 'class', file: 'Models/User.swift', line: 3 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'User', language: 'swift' })
      const result = vaporResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.75)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', language: 'swift' })
      const result = vaporResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts Vapor app.get routes', () => {
      const content = `import Vapor

func routes(_ app: Application) throws {
    app.get("users", use: listUsers)
    app.post("users", use: createUser)
}
`
      const result = vaporResolver.extract!('Routes.swift', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.kind).toBe('route')
      expect(result.nodes[0]!.name).toBe('GET /users')
      expect(result.nodes[1]!.name).toBe('POST /users')
    })

    it('extracts handler references', () => {
      const content = `app.get("users", use: listUsers)`
      const result = vaporResolver.extract!('Routes.swift', content)
      expect(result.references.length).toBe(1)
      expect(result.references[0]!.referenceName).toBe('listUsers')
    })

    it('extracts grouped routes', () => {
      const content = `let todos = routes.grouped("todos")
todos.get(use: index)
todos.post(use: create)`
      const result = vaporResolver.extract!('Routes.swift', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0]!.name).toBe('GET /todos')
      expect(result.nodes[1]!.name).toBe('POST /todos')
    })

    it('extracts self.list handler pattern', () => {
      const content = `app.get("users", use: self.list)`
      const result = vaporResolver.extract!('Controller.swift', content)
      expect(result.references[0]!.referenceName).toBe('list')
    })

    it('returns empty for non-.swift files', () => {
      const result = vaporResolver.extract!('README.md', '# Hello')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Swift-ObjC Bridge Resolver
// ============================================================

describe('Swift-ObjC Bridge Resolver', () => {
  describe('detect', () => {
    it('detects when both .swift and .m files exist', () => {
      const ctx = makeContext({
        getAllFiles: () => ['AppDelegate.swift', 'ViewController.m'],
      })
      expect(swiftObjcBridgeResolver.detect(ctx)).toBe(true)
    })

    it('detects when both .swift and .mm files exist', () => {
      const ctx = makeContext({
        getAllFiles: () => ['MyClass.swift', 'Legacy.mm'],
      })
      expect(swiftObjcBridgeResolver.detect(ctx)).toBe(true)
    })

    it('returns false when only Swift files', () => {
      const ctx = makeContext({
        getAllFiles: () => ['App.swift', 'ContentView.swift'],
      })
      expect(swiftObjcBridgeResolver.detect(ctx)).toBe(false)
    })

    it('returns false when only ObjC files', () => {
      const ctx = makeContext({
        getAllFiles: () => ['ViewController.m', 'Helper.m'],
      })
      expect(swiftObjcBridgeResolver.detect(ctx)).toBe(false)
    })

    it('returns false when no Swift/ObjC files', () => {
      const ctx = makeContext({
        getAllFiles: () => ['main.js', 'app.ts'],
      })
      expect(swiftObjcBridgeResolver.detect(ctx)).toBe(false)
    })
  })

  describe('claimsReference', () => {
    it('claims selector-shaped names with colons', () => {
      expect(swiftObjcBridgeResolver.claimsReference!('downloadURL:completion:')).toBe(true)
    })

    it('claims single-keyword selectors', () => {
      expect(swiftObjcBridgeResolver.claimsReference!('foo:')).toBe(true)
    })

    it('does not claim bare names', () => {
      expect(swiftObjcBridgeResolver.claimsReference!('UserService')).toBe(false)
    })
  })

  describe('resolve', () => {
    it('returns null for non-Swift/ObjC language', () => {
      const ref = makeRef({ referenceName: 'foo:', language: 'javascript' })
      const result = swiftObjcBridgeResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })

    it('returns null when no matching ObjC methods for Swift call', () => {
      const ref = makeRef({ referenceName: 'download', language: 'swift' })
      const result = swiftObjcBridgeResolver.resolve(ref, makeContext({
        getNodesByKind: () => [],
      }))
      expect(result).toBeNull()
    })

    it('returns null for non-selector ObjC references', () => {
      const ref = makeRef({ referenceName: 'someName', language: 'objc' })
      const result = swiftObjcBridgeResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })

    it('resolves Swift call to ObjC method via bridge map', () => {
      // The reverse-bridge map stores ObjC methods by their derived Swift base name.
      // 'playWithSong:' → swiftBaseNamesForObjcSelector returns ['playWithSong', 'play']
      // So Swift caller using 'playWithSong' or 'play' can match.
      const ctx = makeContext({
        getNodesByKind: (kind) => {
          if (kind === 'method') {
            return [{ id: 'objc-1', name: 'playWithSong:', kind: 'method', file: 'Player.m', line: 10, language: 'objc' }]
          }
          return []
        },
        getNodesByName: () => [],
      })
      // Swift caller uses the derived base name 'playWithSong'
      const ref = makeRef({ referenceName: 'playWithSong', language: 'swift' })
      const result = swiftObjcBridgeResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('objc-1')
      expect(result!.confidence).toBe(0.6)
      expect(result!.resolvedBy).toBe('framework')
    })

    it('resolves ObjC selector to Swift @objc method', () => {
      const ctx = makeContext({
        getNodesByKind: () => [],
        getNodesByName: (name) => {
          if (name === 'play') {
            return [{ id: 'swift-1', name: 'play', kind: 'function', file: 'Player.swift', line: 5, language: 'swift' }]
          }
          return []
        },
        readFile: (path) => {
          if (path === 'Player.swift') {
            // Lines 1-5, @objc on line 4, func on line 5
            return 'import Foundation\nclass Player {\n  // plays a song\n  @objc\n  func play(_ song: String) {}\n}\n'
          }
          return null
        },
      })
      const ref = makeRef({ referenceName: 'play:', language: 'objc' })
      const result = swiftObjcBridgeResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('swift-1')
      expect(result!.confidence).toBe(0.6)
    })

    it('strips receiver prefix from ObjC selector', () => {
      const ctx = makeContext({
        getNodesByKind: () => [],
        getNodesByName: (name) => {
          if (name === 'play') {
            return [{ id: 'swift-1', name: 'play', kind: 'function', file: 'Player.swift', line: 5, language: 'swift' }]
          }
          return []
        },
        readFile: (path) => {
          if (path === 'Player.swift') {
            return 'import Foundation\nclass Player {\n  // plays a song\n  @objc\n  func play(_ song: String) {}\n}\n'
          }
          return null
        },
      })
      const ref = makeRef({ referenceName: 'player.play:', language: 'objc' })
      const result = swiftObjcBridgeResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
    })

    it('returns null when ObjC method not @objc-exposed', () => {
      const ctx = makeContext({
        getNodesByKind: () => [],
        getNodesByName: (name) => {
          if (name === 'play') {
            return [{ id: 'swift-1', name: 'play', kind: 'function', file: 'Player.swift', line: 5, language: 'swift' }]
          }
          return []
        },
        readFile: () => 'import Foundation\nclass Player {\n  // plays a song\n  // no objc\n  func play(_ song: String) {}\n}\n',
      })
      const ref = makeRef({ referenceName: 'play:', language: 'objc' })
      const result = swiftObjcBridgeResolver.resolve(ref, ctx)
      expect(result).toBeNull()
    })
  })
})

// ============================================================
// Registration in index.ts
// ============================================================

describe('Framework Registry (Phase 6c-3)', () => {
  beforeEach(() => {
    resetFrameworkResolvers()
  })

  it('registers all 6c-3 resolvers via index.ts', () => {
    // Re-import triggers registration
    // We just check the imported resolvers have correct names
    expect(goResolver.name).toBe('go')
    expect(rustResolver.name).toBe('rust')
    expect(aspnetResolver.name).toBe('aspnet')
    expect(swiftUIResolver.name).toBe('swiftui')
    expect(uikitResolver.name).toBe('uikit')
    expect(vaporResolver.name).toBe('vapor')
    expect(swiftObjcBridgeResolver.name).toBe('swift-objc-bridge')
  })

  it('all resolvers have correct language filters', () => {
    expect(goResolver.languages).toEqual(['go'])
    expect(rustResolver.languages).toEqual(['rust'])
    expect(aspnetResolver.languages).toEqual(['csharp'])
    expect(swiftUIResolver.languages).toEqual(['swift'])
    expect(uikitResolver.languages).toEqual(['swift'])
    expect(vaporResolver.languages).toEqual(['swift'])
    expect(swiftObjcBridgeResolver.languages).toEqual(['swift', 'objc'])
  })

  it('all resolvers implement detect/resolve/extract', () => {
    for (const resolver of [goResolver, rustResolver, aspnetResolver, swiftUIResolver, uikitResolver, vaporResolver, swiftObjcBridgeResolver]) {
      expect(typeof resolver.detect).toBe('function')
      expect(typeof resolver.resolve).toBe('function')
      // swiftObjcBridgeResolver has no extract (cross-language bridge)
      if (resolver.name !== 'swift-objc-bridge') {
        expect(typeof resolver.extract).toBe('function')
      }
    }
  })

  it('can register and retrieve resolvers', () => {
    registerFrameworkResolver(goResolver)
    registerFrameworkResolver(rustResolver)
    const all = getAllFrameworkResolvers()
    expect(all.length).toBe(2)
    expect(all[0]!.name).toBe('go')
    expect(all[1]!.name).toBe('rust')
  })
})

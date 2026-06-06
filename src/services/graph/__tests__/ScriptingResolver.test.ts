/**
 * ScriptingResolver.test.ts — Phase 6c-3: Python + Ruby + Laravel + Drupal + Play framework resolver tests
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { djangoResolver, flaskResolver, fastapiResolver } from '../resolution/frameworks/python.js'
import { railsResolver } from '../resolution/frameworks/ruby.js'
import { laravelResolver } from '../resolution/frameworks/laravel.js'
import { drupalResolver } from '../resolution/frameworks/drupal.js'
import { playResolver } from '../resolution/frameworks/play.js'
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
    filePath: 'src/app.py',
    language: 'python',
    ...overrides,
  }
}

function makeNode(overrides: Partial<NodeMetadata> = {}): NodeMetadata {
  return {
    id: 'node-1',
    kind: 'function',
    name: 'test_func',
    qualified_name: 'module.test_func',
    file: 'src/app.py',
    line: 1,
    end_line: 5,
    start_column: 0,
    end_column: 10,
    language: 'python',
    updated_at: Date.now(),
    ...overrides,
  }
}

// ============================================================
// Python Resolvers (Django + Flask + FastAPI)
// ============================================================

describe('Python Resolvers', () => {
  // ------ Django ------
  describe('Django Resolver', () => {
    describe('detect', () => {
      it('detects django in requirements.txt', () => {
        const ctx = makeContext({
          readFile: (f) => f === 'requirements.txt' ? 'Django>=4.0\npsycopg2' : null,
        })
        expect(djangoResolver.detect(ctx)).toBe(true)
      })

      it('detects django in pyproject.toml', () => {
        const ctx = makeContext({
          readFile: (f) => f === 'pyproject.toml' ? '[tool.poetry.dependencies]\ndjango = "^4.0"' : null,
        })
        expect(djangoResolver.detect(ctx)).toBe(true)
      })

      it('detects django by manage.py', () => {
        const ctx = makeContext({
          fileExists: (f) => f === 'manage.py',
        })
        expect(djangoResolver.detect(ctx)).toBe(true)
      })

      it('returns false for non-django project', () => {
        const ctx = makeContext()
        expect(djangoResolver.detect(ctx)).toBe(false)
      })
    })

    describe('resolve', () => {
      it('resolves Model references', () => {
        const ctx = makeContext({
          getNodesByName: (name) => {
            if (name === 'ArticleModel') return [makeNode({ id: 'model-1', name: 'ArticleModel', kind: 'class', file: 'app/models/article.py' })]
            return []
          },
        })
        const ref = makeRef({ referenceName: 'ArticleModel', language: 'python' })
        const result = djangoResolver.resolve(ref, ctx)
        expect(result).not.toBeNull()
        expect(result!.targetNodeId).toBe('model-1')
        expect(result!.confidence).toBe(0.8)
      })

      it('resolves View references', () => {
        const ctx = makeContext({
          getNodesByName: (name) => {
            if (name === 'ArticleViewSet') return [makeNode({ id: 'view-1', name: 'ArticleViewSet', kind: 'class', file: 'api/views.py' })]
            return []
          },
        })
        const ref = makeRef({ referenceName: 'ArticleViewSet', language: 'python' })
        const result = djangoResolver.resolve(ref, ctx)
        expect(result).not.toBeNull()
        expect(result!.targetNodeId).toBe('view-1')
      })

      it('resolves _iterable_class ORM dispatch', () => {
        const ctx = makeContext({
          getNodesByName: (name) => {
            if (name === 'ModelIterable') return [makeNode({ id: 'cls-1', name: 'ModelIterable', kind: 'class', file: 'django/db/models/query.py', line: 10, end_line: 50 })]
            if (name === '__iter__') return [makeNode({ id: 'iter-1', name: '__iter__', kind: 'method', file: 'django/db/models/query.py', line: 20 })]
            return []
          },
        })
        const ref = makeRef({ referenceName: '_iterable_class', language: 'python' })
        const result = djangoResolver.resolve(ref, ctx)
        expect(result).not.toBeNull()
        expect(result!.targetNodeId).toBe('iter-1')
        expect(result!.confidence).toBe(0.7)
      })

      it('claims _iterable_class reference', () => {
        expect(djangoResolver.claimsReference!('_iterable_class')).toBe(true)
        expect(djangoResolver.claimsReference!('something_else')).toBe(false)
      })

      it('returns null for unresolvable references', () => {
        const ctx = makeContext()
        const ref = makeRef({ referenceName: 'unknown_func', language: 'python' })
        expect(djangoResolver.resolve(ref, ctx)).toBeNull()
      })
    })

    describe('extract', () => {
      it('extracts Django URL patterns', () => {
        const content = `from django.urls import path
from . import views

urlpatterns = [
    path('articles/', views.article_list, name='article-list'),
    path('articles/<int:pk>/', views.ArticleDetailView.as_view(), name='article-detail'),
]`
        const result = djangoResolver.extract!('urls.py', content)
        expect(result.nodes.length).toBe(2)
        expect(result.nodes[0].kind).toBe('route')
        expect(result.nodes[0].name).toBe('articles/')
        expect(result.references.length).toBe(2)
        expect(result.references[0].referenceName).toBe('article_list')
        expect(result.references[1].referenceName).toBe('ArticleDetailView')
      })

      it('extracts DRF router registrations', () => {
        const content = `from rest_framework.routers import DefaultRouter
router = DefaultRouter()
router.register(r'articles', ArticleViewSet)
router.register(r'users', UserViewSet)`
        const result = djangoResolver.extract!('urls.py', content)
        const viewsetRefs = result.references.filter(r => r.referenceName.endsWith('ViewSet'))
        expect(viewsetRefs.length).toBe(2)
      })

      it('returns empty for non-.py files', () => {
        const result = djangoResolver.extract!('app.js', 'path("/foo", view)')
        expect(result.nodes.length).toBe(0)
      })
    })
  })

  // ------ Flask ------
  describe('Flask Resolver', () => {
    describe('detect', () => {
      it('detects flask in requirements.txt', () => {
        const ctx = makeContext({
          readFile: (f) => f === 'requirements.txt' ? 'Flask>=2.0' : null,
        })
        expect(flaskResolver.detect(ctx)).toBe(true)
      })

      it('detects flask by Flask() instantiation in app.py', () => {
        const ctx = makeContext({
          readFile: (f) => {
            if (f === 'requirements.txt') return null
            if (f === 'app.py') return 'from flask import Flask\napp = Flask(__name__)'
            return null
          },
          getAllFiles: () => ['app.py'],
        })
        expect(flaskResolver.detect(ctx)).toBe(true)
      })
    })

    describe('resolve', () => {
      it('resolves blueprint references', () => {
        const ctx = makeContext({
          getNodesByName: (name) => {
            if (name === 'api_bp') return [makeNode({ id: 'bp-1', name: 'api_bp', kind: 'variable', file: 'app/api/__init__.py' })]
            return []
          },
        })
        const ref = makeRef({ referenceName: 'api_bp', language: 'python' })
        const result = flaskResolver.resolve(ref, ctx)
        expect(result).not.toBeNull()
        expect(result!.targetNodeId).toBe('bp-1')
      })
    })

    describe('extract', () => {
      it('extracts Flask @app.route decorators', () => {
        const content = `from flask import Flask
app = Flask(__name__)

@app.route('/hello')
def hello():
    return 'Hello'

@app.route('/users', methods=['POST'])
def create_user():
    return 'Created'`
        const result = flaskResolver.extract!('app.py', content)
        expect(result.nodes.length).toBe(2)
        expect(result.nodes[0].name).toBe('GET /hello')
        expect(result.nodes[1].name).toBe('POST /users')
        expect(result.references.length).toBe(2)
        expect(result.references[0].referenceName).toBe('hello')
        expect(result.references[1].referenceName).toBe('create_user')
      })

      it('extracts Flask-RESTful add_resource', () => {
        const content = `api.add_resource(ArticleResource, '/articles', '/articles/<int:id>')
api.add_resource(UserResource, '/users')`
        const result = flaskResolver.extract!('app.py', content)
        expect(result.nodes.length).toBe(3) // 2 paths for Article + 1 for User
        expect(result.references.length).toBe(3)
        expect(result.references[0].referenceName).toBe('ArticleResource')
      })
    })
  })

  // ------ FastAPI ------
  describe('FastAPI Resolver', () => {
    describe('detect', () => {
      it('detects fastapi in requirements.txt', () => {
        const ctx = makeContext({
          readFile: (f) => f === 'requirements.txt' ? 'fastapi>=0.100.0' : null,
        })
        expect(fastapiResolver.detect(ctx)).toBe(true)
      })

      it('detects fastapi by FastAPI() in main.py', () => {
        const ctx = makeContext({
          readFile: (f) => f === 'main.py' ? 'from fastapi import FastAPI\napp = FastAPI()' : null,
        })
        expect(fastapiResolver.detect(ctx)).toBe(true)
      })
    })

    describe('resolve', () => {
      it('resolves router references', () => {
        const ctx = makeContext({
          getNodesByName: (name) => {
            if (name === 'users_router') return [makeNode({ id: 'router-1', name: 'users_router', kind: 'variable', file: 'routers/users.py' })]
            return []
          },
        })
        const ref = makeRef({ referenceName: 'users_router', language: 'python' })
        const result = fastapiResolver.resolve(ref, ctx)
        expect(result).not.toBeNull()
        expect(result!.targetNodeId).toBe('router-1')
      })

      it('resolves dependency injection functions', () => {
        const ctx = makeContext({
          getNodesByName: (name) => {
            if (name === 'get_current_user') return [makeNode({ id: 'dep-1', name: 'get_current_user', kind: 'function', file: 'deps/auth.py' })]
            return []
          },
        })
        const ref = makeRef({ referenceName: 'get_current_user', language: 'python' })
        const result = fastapiResolver.resolve(ref, ctx)
        expect(result).not.toBeNull()
        expect(result!.targetNodeId).toBe('dep-1')
        expect(result!.confidence).toBe(0.75)
      })
    })

    describe('extract', () => {
      it('extracts FastAPI route decorators', () => {
        const content = `from fastapi import APIRouter
router = APIRouter()

@router.get('/items')
async def list_items():
    return []

@router.post('/items')
async def create_item():
    return {}`
        const result = fastapiResolver.extract!('routes.py', content)
        expect(result.nodes.length).toBe(2)
        expect(result.nodes[0].name).toBe('GET /items')
        expect(result.nodes[1].name).toBe('POST /items')
        expect(result.references[0].referenceName).toBe('list_items')
        expect(result.references[1].referenceName).toBe('create_item')
      })
    })
  })
})

// ============================================================
// Ruby Resolver (Rails)
// ============================================================

describe('Ruby Rails Resolver', () => {
  describe('detect', () => {
    it('detects rails in Gemfile', () => {
      const ctx = makeContext({
        readFile: (f) => f === 'Gemfile' ? "gem 'rails', '~> 7.0'" : null,
      })
      expect(railsResolver.detect(ctx)).toBe(true)
    })

    it('detects rails by config/application.rb', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'config/application.rb',
      })
      expect(railsResolver.detect(ctx)).toBe(true)
    })

    it('detects rails by routes.rb', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'config/routes.rb',
      })
      expect(railsResolver.detect(ctx)).toBe(true)
    })

    it('returns false for non-rails project', () => {
      const ctx = makeContext()
      expect(railsResolver.detect(ctx)).toBe(false)
    })
  })

  describe('claimsReference', () => {
    it('claims controller#action references', () => {
      expect(railsResolver.claimsReference!('articles#index')).toBe(true)
      expect(railsResolver.claimsReference!('admin/users#show')).toBe(true)
      expect(railsResolver.claimsReference!('some_func')).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves controller#action references', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'app/controllers/articles_controller.rb',
        getNodesInFile: (f) => {
          if (f === 'app/controllers/articles_controller.rb') {
            return [makeNode({ id: 'action-1', name: 'index', kind: 'method', file: f, language: 'ruby' })]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'articles#index', language: 'ruby' })
      const result = railsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('action-1')
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves model references by class name', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'Article') return [makeNode({ id: 'model-1', name: 'Article', kind: 'class', file: 'app/models/article.rb', language: 'ruby' })]
          return []
        },
      })
      const ref = makeRef({ referenceName: 'Article', language: 'ruby' })
      const result = railsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('model-1')
    })

    it('resolves controller references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'ArticlesController') return [makeNode({ id: 'ctrl-1', name: 'ArticlesController', kind: 'class', file: 'app/controllers/articles_controller.rb', language: 'ruby' })]
          return []
        },
      })
      const ref = makeRef({ referenceName: 'ArticlesController', language: 'ruby' })
      const result = railsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('ctrl-1')
    })

    it('resolves helper references', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'app/helpers/articles_helper.rb',
        getNodesInFile: (f) => {
          if (f === 'app/helpers/articles_helper.rb') {
            return [makeNode({ id: 'helper-1', name: 'ArticlesHelper', kind: 'module', file: f, language: 'ruby' })]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'ArticlesHelper', language: 'ruby' })
      const result = railsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('helper-1')
    })

    it('resolves service/job references', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'app/services/article_service.rb',
        getNodesInFile: (f) => {
          if (f === 'app/services/article_service.rb') {
            return [makeNode({ id: 'svc-1', name: 'ArticleService', kind: 'class', file: f, language: 'ruby' })]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'ArticleService', language: 'ruby' })
      const result = railsResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('svc-1')
    })
  })

  describe('extract', () => {
    it('extracts Rails route definitions', () => {
      const content = `Rails.application.routes.draw do
  get '/articles', to: 'articles#index'
  post '/articles', to: 'articles#create'
  get '/articles/:id', to: 'articles#show'
end`
      const result = railsResolver.extract!('config/routes.rb', content)
      expect(result.nodes.length).toBe(3)
      expect(result.nodes[0].name).toBe('GET /articles')
      expect(result.nodes[0].kind).toBe('route')
      expect(result.references.length).toBe(3)
      expect(result.references[0].referenceName).toBe('articles#index')
      expect(result.references[1].referenceName).toBe('articles#create')
    })

    it('extracts RESTful resources', () => {
      const content = `Rails.application.routes.draw do
  resources :articles
end`
      const result = railsResolver.extract!('config/routes.rb', content)
      // resources :articles generates 7 RESTful routes
      expect(result.nodes.length).toBe(7)
      expect(result.nodes.map(n => n.name)).toEqual([
        'GET /articles', 'POST /articles', 'GET /articles/new',
        'GET /articles/:id', 'GET /articles/:id/edit',
        'PATCH /articles/:id', 'DELETE /articles/:id',
      ])
    })

    it('handles resources with :only constraint', () => {
      const content = `resources :articles, only: [:index, :show]`
      const result = railsResolver.extract!('config/routes.rb', content)
      expect(result.nodes.length).toBe(2)
    })

    it('handles singular resource', () => {
      const content = `resource :profile`
      const result = railsResolver.extract!('config/routes.rb', content)
      // Singular resource: 6 routes (no index)
      expect(result.nodes.length).toBe(6)
    })

    it('returns empty for non-.rb files', () => {
      const result = railsResolver.extract!('app.js', 'get "/foo"')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Laravel Resolver (PHP)
// ============================================================

describe('Laravel Resolver', () => {
  describe('detect', () => {
    it('detects laravel by artisan file', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'artisan',
      })
      expect(laravelResolver.detect(ctx)).toBe(true)
    })

    it('detects laravel by Kernel.php', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'app/Http/Kernel.php',
      })
      expect(laravelResolver.detect(ctx)).toBe(true)
    })

    it('returns false for non-laravel project', () => {
      const ctx = makeContext()
      expect(laravelResolver.detect(ctx)).toBe(false)
    })
  })

  describe('claimsReference', () => {
    it('claims Controller@method references', () => {
      expect(laravelResolver.claimsReference!('ArticleController@index')).toBe(true)
      expect(laravelResolver.claimsReference!('UserController@show')).toBe(true)
      expect(laravelResolver.claimsReference!('some_func')).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves Model::method() calls', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'app/Models/Article.php',
        getNodesInFile: (f) => {
          if (f === 'app/Models/Article.php') {
            return [
              makeNode({ id: 'model-cls', name: 'Article', kind: 'class', file: f, language: 'php' }),
              makeNode({ id: 'model-mtd', name: 'findBySlug', kind: 'method', file: f, language: 'php' }),
            ]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'Article::findBySlug', language: 'php' })
      const result = laravelResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('model-mtd')
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves Controller@method references', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'app/Http/Controllers/ArticleController.php',
        getNodesInFile: (f) => {
          if (f === 'app/Http/Controllers/ArticleController.php') {
            return [makeNode({ id: 'ctrl-mtd', name: 'index', kind: 'method', file: f, language: 'php' })]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'ArticleController@index', language: 'php' })
      const result = laravelResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('ctrl-mtd')
      expect(result!.confidence).toBe(0.9)
    })

    it('returns null for facade calls', () => {
      const ctx = makeContext()
      const ref = makeRef({ referenceName: 'Auth::user', language: 'php' })
      expect(laravelResolver.resolve(ref, ctx)).toBeNull()
    })

    it('returns null for helper functions', () => {
      const ctx = makeContext()
      const ref = makeRef({ referenceName: 'route', language: 'php' })
      expect(laravelResolver.resolve(ref, ctx)).toBeNull()
    })
  })

  describe('extract', () => {
    it('extracts Laravel Route::get/post definitions', () => {
      const content = `<?php
Route::get('/articles', [ArticleController::class, 'index']);
Route::post('/articles', [ArticleController::class, 'store']);
Route::get('/articles/{id}', 'ArticleController@show');`
      const result = laravelResolver.extract!('routes/web.php', content)
      expect(result.nodes.length).toBe(3)
      expect(result.nodes[0].kind).toBe('route')
      expect(result.nodes[0].name).toBe('GET /articles')
      expect(result.references.length).toBe(3)
      // [Class::class, 'method'] → Class@method
      expect(result.references[0].referenceName).toBe('ArticleController@index')
      expect(result.references[2].referenceName).toBe('ArticleController@show')
    })

    it('extracts Route::resource', () => {
      const content = `Route::resource('articles', ArticleController::class);`
      const result = laravelResolver.extract!('routes/web.php', content)
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0].name).toBe('resource:articles')
      expect(result.references[0].referenceName).toBe('ArticleController')
    })

    it('returns empty for non-.php files', () => {
      const result = laravelResolver.extract!('app.py', 'Route::get("/foo")')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Drupal Resolver (PHP)
// ============================================================

describe('Drupal Resolver', () => {
  describe('detect', () => {
    it('detects drupal by composer.json drupal/* dependency', () => {
      const ctx = makeContext({
        readFile: (f) => {
          if (f === 'composer.json') return JSON.stringify({ require: { 'drupal/core': '^10.0' } })
          return null
        },
      })
      expect(drupalResolver.detect(ctx)).toBe(true)
    })

    it('detects drupal by composer.json name', () => {
      const ctx = makeContext({
        readFile: (f) => {
          if (f === 'composer.json') return JSON.stringify({ name: 'drupal/my_module' })
          return null
        },
      })
      expect(drupalResolver.detect(ctx)).toBe(true)
    })

    it('detects drupal by composer.json type', () => {
      const ctx = makeContext({
        readFile: (f) => {
          if (f === 'composer.json') return JSON.stringify({ type: 'drupal-module' })
          return null
        },
      })
      expect(drupalResolver.detect(ctx)).toBe(true)
    })

    it('detects drupal by .info.yml + .routing.yml', () => {
      const ctx = makeContext({
        getAllFiles: () => ['my_module.info.yml', 'my_module.routing.yml'],
      })
      expect(drupalResolver.detect(ctx)).toBe(true)
    })

    it('detects drupal by .info.yml + .module', () => {
      const ctx = makeContext({
        getAllFiles: () => ['my_module.info.yml', 'my_module.module'],
      })
      expect(drupalResolver.detect(ctx)).toBe(true)
    })

    it('returns false for non-drupal project', () => {
      const ctx = makeContext()
      expect(drupalResolver.detect(ctx)).toBe(false)
    })
  })

  describe('claimsReference', () => {
    it('claims hook_* references', () => {
      expect(drupalResolver.claimsReference!('hook_form_alter')).toBe(true)
    })

    it('claims FQCN references', () => {
      expect(drupalResolver.claimsReference!('\\Drupal\\mymodule\\Controller\\Foo')).toBe(true)
    })

    it('claims Class::method references', () => {
      expect(drupalResolver.claimsReference!('MyController::index')).toBe(true)
    })

    it('claims Class:method (single colon) references', () => {
      expect(drupalResolver.claimsReference!('MyController:list')).toBe(true)
    })
  })

  describe('resolve', () => {
    it('resolves controller::method FQCN references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'MyController') return [makeNode({ id: 'cls-1', name: 'MyController', kind: 'class', file: 'src/Controller/MyController.php', language: 'php' })]
          return []
        },
        getNodesInFile: (f) => {
          if (f === 'src/Controller/MyController.php') {
            return [
              makeNode({ id: 'cls-1', name: 'MyController', kind: 'class', file: f, language: 'php' }),
              makeNode({ id: 'mtd-1', name: 'index', kind: 'method', file: f, language: 'php' }),
            ]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: '\\Drupal\\mymodule\\Controller\\MyController::index', language: 'php' })
      const result = drupalResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('mtd-1')
      expect(result!.confidence).toBe(0.9)
    })

    it('resolves bare FQCN form references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'MyForm') return [makeNode({ id: 'form-1', name: 'MyForm', kind: 'class', file: 'src/Form/MyForm.php', language: 'php' })]
          return []
        },
      })
      const ref = makeRef({ referenceName: '\\Drupal\\mymodule\\Form\\MyForm', language: 'php' })
      const result = drupalResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('form-1')
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves hook_* references', () => {
      const ctx = makeContext({
        getNodesByKind: (kind) => {
          if (kind === 'function') return [makeNode({ id: 'hook-1', name: 'mymodule_form_alter', kind: 'function', file: 'mymodule.module', language: 'php' })]
          return []
        },
      })
      const ref = makeRef({ referenceName: 'hook_form_alter', language: 'php' })
      const result = drupalResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('hook-1')
      expect(result!.confidence).toBe(0.75)
    })
  })

  describe('extract', () => {
    it('extracts routes from .routing.yml', () => {
      const content = `mymodule.admin:
  path: '/admin/mymodule'
  defaults:
    _controller: '\\Drupal\\mymodule\\Controller\\AdminController::content'
    _title: 'My Module Admin'
  requirements:
    _permission: 'administer my module'

mymodule.form:
  path: '/admin/mymodule/form'
  defaults:
    _form: '\\Drupal\\mymodule\\Form\\SettingsForm'
  requirements:
    _permission: 'administer my module'`
      const result = drupalResolver.extract!('mymodule.routing.yml', content)
      expect(result.nodes.length).toBe(2)
      expect(result.nodes[0].kind).toBe('route')
      expect(result.nodes[0].name).toBe('/admin/mymodule')
      expect(result.references.length).toBe(2)
      expect(result.references[0].referenceName).toBe('\\Drupal\\mymodule\\Controller\\AdminController::content')
      expect(result.references[1].referenceName).toBe('\\Drupal\\mymodule\\Form\\SettingsForm')
    })

    it('extracts hook implementations from .module files', () => {
      const content = `<?php

/**
 * Implements hook_form_alter().
 */
function mymodule_form_alter(&$form, $form_state, $form_id) {
  // ...
}

/**
 * Implements hook_theme().
 */
function mymodule_theme($existing, $type, $theme, $path) {
  // ...
}`
      const result = drupalResolver.extract!('mymodule.module', content)
      // extract returns only references (no nodes for hooks — they reference existing function nodes)
      expect(result.references.length).toBe(2)
      expect(result.references[0].referenceName).toBe('hook_form_alter')
      expect(result.references[1].referenceName).toBe('hook_theme')
    })

    it('extracts hook implementations via name pattern fallback', () => {
      // Content without docblock — uses name pattern: mymodule_page_alter → hook_page_alter
      const content = [
        '<?php',
        'function mymodule_page_alter(&$page) {',
        '  return $page;',
        '}',
      ].join('\n')
      const result = drupalResolver.extract!('mymodule.module', content)
      expect(result.references.length).toBe(1)
      expect(result.references[0].referenceName).toBe('hook_page_alter')
    })

    it('returns empty for unrelated files', () => {
      const result = drupalResolver.extract!('style.css', 'body { color: red; }')
      expect(result.nodes.length).toBe(0)
      expect(result.references.length).toBe(0)
    })
  })
})

// ============================================================
// Play Framework Resolver (Scala/Java)
// ============================================================

describe('Play Framework Resolver', () => {
  describe('detect', () => {
    it('detects play in build.sbt', () => {
      const ctx = makeContext({
        readFile: (f) => {
          if (f === 'build.sbt') return 'lazy val root = (project in file(".")).enablePlugins(PlayScala)'
          return null
        },
      })
      expect(playResolver.detect(ctx)).toBe(true)
    })

    it('detects play by conf/routes file', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'conf/routes',
      })
      expect(playResolver.detect(ctx)).toBe(true)
    })

    it('detects play by conf/application.conf', () => {
      const ctx = makeContext({
        fileExists: (f) => f === 'conf/application.conf',
      })
      expect(playResolver.detect(ctx)).toBe(true)
    })

    it('returns false for non-play project', () => {
      const ctx = makeContext()
      expect(playResolver.detect(ctx)).toBe(false)
    })
  })

  describe('claimsReference', () => {
    it('claims Controller.method references', () => {
      expect(playResolver.claimsReference!('Application.index')).toBe(true)
      expect(playResolver.claimsReference!('Users.list')).toBe(true)
      expect(playResolver.claimsReference!('some_func')).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves Controller.method references', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'Application') return [makeNode({ id: 'cls-1', name: 'Application', kind: 'class', file: 'app/controllers/Application.scala', language: 'scala' })]
          return []
        },
        getNodesInFile: (f) => {
          if (f === 'app/controllers/Application.scala') {
            return [
              makeNode({ id: 'cls-1', name: 'Application', kind: 'class', file: f, language: 'scala' }),
              makeNode({ id: 'mtd-1', name: 'index', kind: 'method', file: f, language: 'scala' }),
            ]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'Application.index', language: 'scala' })
      const result = playResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('mtd-1')
      expect(result!.confidence).toBe(0.9)
    })
  })

  describe('extract', () => {
    it('extracts Play routes from conf/routes', () => {
      const content = `# Routes
GET   /                   controllers.Application.index
POST  /api/articles       controllers.Application.create(p: Int ?= 0)
GET   /assets/*file       controllers.Assets.versioned(path="/public", file: Asset)
->    /api                api.Routes`
      const result = playResolver.extract!('conf/routes', content)
      expect(result.nodes.length).toBe(3) // 3 actual routes (not the -> include)
      expect(result.nodes[0].kind).toBe('route')
      expect(result.nodes[0].name).toBe('GET /')
      expect(result.references.length).toBe(3)
      expect(result.references[0].referenceName).toBe('Application.index')
      expect(result.references[1].referenceName).toBe('Application.create')
    })

    it('skips comments and includes', () => {
      const content = `# This is a comment
-> /api api.Routes
GET / controllers.Home.index`
      const result = playResolver.extract!('conf/routes', content)
      expect(result.nodes.length).toBe(1)
    })

    it('returns empty for non-routes files', () => {
      const result = playResolver.extract!('app.scala', 'GET /foo controllers.Foo.bar')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Registration
// ============================================================

describe('Framework Registration', () => {
  it('registers all 5 scripting resolvers via index.ts', () => {
    // The resolvers are registered at module import time (top-level registerFrameworkResolver calls).
    // Importing index.ts triggers registration, so they should already be in the global list.
    const resolvers = getAllFrameworkResolvers()
    const names = resolvers.map(r => r.name)
    expect(names).toContain('django')
    expect(names).toContain('flask')
    expect(names).toContain('fastapi')
    expect(names).toContain('rails')
    expect(names).toContain('laravel')
    expect(names).toContain('drupal')
    expect(names).toContain('play')
  })

  it('resetFrameworkResolvers clears and re-register works', () => {
    resetFrameworkResolvers()
    expect(getAllFrameworkResolvers().length).toBe(0)
    registerFrameworkResolver(djangoResolver)
    expect(getAllFrameworkResolvers().length).toBe(1)
    expect(getAllFrameworkResolvers()[0].name).toBe('django')
  })
})

/**
 * Parser tests — verify all non-code file parsers extract correct nodes and edges.
 */

import { describe, test, expect } from 'bun:test'
import { DockerfileParser } from '../parsers/DockerfileParser.js'
import { CIParser } from '../parsers/CIParser.js'
import { YAMLParser } from '../parsers/YAMLParser.js'
import { JSONParser } from '../parsers/JSONParser.js'
import { TerraformParser } from '../parsers/TerraformParser.js'
import { OpenAPIParser } from '../parsers/OpenAPIParser.js'
import { GraphQLParser } from '../parsers/GraphQLParser.js'
import { ProtobufParser } from '../parsers/ProtobufParser.js'
import { SQLParser } from '../parsers/SQLParser.js'
import { ParserRegistry } from '../parsers/ParserRegistry.js'
import { createDefaultRegistry } from '../parsers/index.js'

// ============================================================
// DockerfileParser
// ============================================================

describe('DockerfileParser', () => {
  const parser = new DockerfileParser()

  test('parses multi-stage Dockerfile', () => {
    const content = `
FROM node:18 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:18-slim AS production
WORKDIR /app
COPY --from=builder /app/dist ./dist
EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--port", "3000"]
`.trim()

    const result = parser.parse('/app/Dockerfile', content)
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('dockerfile')

    // Should have stages
    const stages = result!.nodes.filter(n => n.kind === 'stage')
    expect(stages.length).toBeGreaterThanOrEqual(2)
    expect(stages.map(s => s.name)).toContain('builder')
    expect(stages.map(s => s.name)).toContain('production')

    // Should have base images
    const images = result!.nodes.filter(n => n.kind === 'image')
    expect(images.length).toBeGreaterThanOrEqual(2)

    // Should have ports
    const ports = result!.nodes.filter(n => n.kind === 'port')
    expect(ports.some(p => p.name === '3000')).toBe(true)

    // Should have entrypoint
    const entrypoints = result!.nodes.filter(n => n.kind === 'entrypoint')
    expect(entrypoints.length).toBe(1)

    // Should have command
    const commands = result!.nodes.filter(n => n.kind === 'command')
    expect(commands.length).toBe(1)

    // Edges: stage uses image
    const usesEdges = result!.edges.filter(e => e.type === 'uses')
    expect(usesEdges.length).toBeGreaterThanOrEqual(2)

    // Edges: stage exposes port
    const exposeEdges = result!.edges.filter(e => e.type === 'exposes')
    expect(exposeEdges.length).toBe(1)
  })

  test('parses simple Dockerfile', () => {
    const content = `
FROM python:3.11
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
EXPOSE 8080
`.trim()

    const result = parser.parse('/app/Dockerfile', content)
    expect(result).not.toBeNull()
    expect(result!.nodes.some(n => n.kind === 'stage')).toBe(true)
    expect(result!.nodes.some(n => n.kind === 'port')).toBe(true)
  })

  test('returns null for empty Dockerfile', () => {
    const result = parser.parse('/app/Dockerfile', '# Just a comment')
    // Only default stage, nothing useful
    expect(result).toBeNull()
  })

  test('handles EXPOSE with multiple ports', () => {
    const content = `FROM nginx\nEXPOSE 80 443 8080`
    const result = parser.parse('/app/Dockerfile', content)
    expect(result).not.toBeNull()
    const ports = result!.nodes.filter(n => n.kind === 'port')
    expect(ports.length).toBe(3)
  })

  test('matches Dockerfile variants', () => {
    expect(parser.filePatterns).toContain('Dockerfile')
    expect(parser.filePatterns).toContain('Dockerfile.dev')
    expect(parser.filePatterns).toContain('Dockerfile.prod')
  })
})

// ============================================================
// CIParser
// ============================================================

describe('CIParser', () => {
  const parser = new CIParser()

  test('parses GitHub Actions workflow', () => {
    const content = `
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
`.trim()

    const result = parser.parse('/repo/.github/workflows/ci.yml', content)
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('ci')

    // Workflow node
    const workflows = result!.nodes.filter(n => n.kind === 'workflow')
    expect(workflows.length).toBe(1)
    expect(workflows[0].name).toBe('CI')

    // Jobs
    const jobs = result!.nodes.filter(n => n.kind === 'job')
    expect(jobs.length).toBe(2)
    expect(jobs.map(j => j.name)).toContain('build')
    expect(jobs.map(j => j.name)).toContain('lint')

    // Steps with uses
    const steps = result!.nodes.filter(n => n.kind === 'step')
    expect(steps.length).toBeGreaterThanOrEqual(4)

    // Actions
    const actions = result!.nodes.filter(n => n.kind === 'action')
    expect(actions.some(a => a.name === 'actions/checkout')).toBe(true)
    expect(actions.some(a => a.name === 'actions/setup-node')).toBe(true)

    // Edges: workflow contains jobs
    const containsEdges = result!.edges.filter(e => e.type === 'contains')
    expect(containsEdges.length).toBeGreaterThanOrEqual(2)

    // Edges: job depends on job
    const dependsEdges = result!.edges.filter(e => e.type === 'depends')
    expect(dependsEdges.length).toBeGreaterThanOrEqual(1)

    // Edges: step uses action
    const usesEdges = result!.edges.filter(e => e.type === 'uses')
    expect(usesEdges.length).toBeGreaterThanOrEqual(3)
  })

  test('ignores non-workflow YAML files', () => {
    const result = parser.parse('/repo/config.yml', 'key: value')
    expect(result).toBeNull()
  })

  test('parses workflow with run steps', () => {
    const content = `
name: Deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploying"
      - run: npm run build
`.trim()

    const result = parser.parse('/repo/.github/workflows/deploy.yml', content)
    expect(result).not.toBeNull()
    const steps = result!.nodes.filter(n => n.kind === 'step')
    expect(steps.length).toBe(2)
  })
})

// ============================================================
// YAMLParser
// ============================================================

describe('YAMLParser', () => {
  const parser = new YAMLParser()

  test('parses docker-compose file', () => {
    const content = `
services:
  web:
    image: nginx:latest
    ports:
      - 8080:80
    depends_on:
      - api

  api:
    image: node:18
    ports:
      - 3000:3000

  db:
    image: postgres:15
    ports:
      - 5432:5432
`.trim()

    const result = parser.parse('/repo/docker-compose.yml', content)
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('yaml')

    // Services
    const services = result!.nodes.filter(n => n.kind === 'service')
    expect(services.length).toBe(3)
    expect(services.map(s => s.name)).toContain('web')
    expect(services.map(s => s.name)).toContain('api')
    expect(services.map(s => s.name)).toContain('db')

    // Images
    const images = result!.nodes.filter(n => n.kind === 'image')
    expect(images.length).toBe(3)

    // Ports
    const ports = result!.nodes.filter(n => n.kind === 'port')
    expect(ports.length).toBe(3)

    // Depends edges
    const dependsEdges = result!.edges.filter(e => e.type === 'depends')
    expect(dependsEdges.length).toBeGreaterThanOrEqual(1)
  })

  test('parses k8s manifest', () => {
    const content = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: app
          image: my-app:latest
          containerPort: 8080
`.trim()

    const result = parser.parse('/repo/k8s/deployment.yml', content)
    expect(result).not.toBeNull()

    const resources = result!.nodes.filter(n => n.kind === 'deployment')
    expect(resources.length).toBe(1)
    expect(resources[0].name).toBe('my-app')
  })

  test('parses generic YAML', () => {
    const content = `
database:
  host: localhost
  port: 5432

server:
  port: 3000
`.trim()

    const result = parser.parse('/repo/config.yml', content)
    expect(result).not.toBeNull()
    expect(result!.nodes.length).toBeGreaterThanOrEqual(2)
  })
})

// ============================================================
// JSONParser
// ============================================================

describe('JSONParser', () => {
  const parser = new JSONParser()

  test('parses package.json', () => {
    const content = JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      main: 'dist/index.js',
      scripts: {
        build: 'tsc',
        test: 'jest',
        lint: 'eslint src/',
      },
      dependencies: {
        express: '^4.18.0',
        lodash: '^4.17.21',
      },
      devDependencies: {
        typescript: '^5.0.0',
        jest: '^29.0.0',
      },
      workspaces: ['packages/*'],
    })

    const result = parser.parse('/repo/package.json', content)
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('json')

    // Package node
    const packages = result!.nodes.filter(n => n.kind === 'package')
    expect(packages.length).toBe(1)
    expect(packages[0].name).toBe('my-app')

    // Scripts
    const scripts = result!.nodes.filter(n => n.kind === 'script')
    expect(scripts.length).toBe(3)
    expect(scripts.map(s => s.name)).toContain('build')
    expect(scripts.map(s => s.name)).toContain('test')
    expect(scripts.map(s => s.name)).toContain('lint')

    // Dependencies
    const deps = result!.nodes.filter(n => n.kind === 'dependency')
    expect(deps.length).toBe(4)
    expect(deps.some(d => d.name === 'express')).toBe(true)
    expect(deps.some(d => d.name === 'typescript')).toBe(true)

    // Entry
    const entries = result!.nodes.filter(n => n.kind === 'entry')
    expect(entries.length).toBe(1)

    // Workspaces
    const workspaces = result!.nodes.filter(n => n.kind === 'workspace')
    expect(workspaces.length).toBe(1)

    // Edges
    const depEdges = result!.edges.filter(e => e.type === 'depends')
    expect(depEdges.length).toBe(4)

    const definesEdges = result!.edges.filter(e => e.type === 'defines')
    expect(definesEdges.length).toBe(3)
  })

  test('parses tsconfig.json', () => {
    const content = JSON.stringify({
      extends: '@tsconfig/node18/tsconfig.json',
      compilerOptions: { target: 'ES2022', module: 'commonjs' },
      references: [
        { path: './packages/core' },
        { path: './packages/utils' },
      ],
    })

    const result = parser.parse('/repo/tsconfig.json', content)
    expect(result).not.toBeNull()

    const tsconfigs = result!.nodes.filter(n => n.kind === 'tsconfig')
    expect(tsconfigs.length).toBeGreaterThanOrEqual(1)

    const extendsEdges = result!.edges.filter(e => e.type === 'extends')
    expect(extendsEdges.length).toBe(1)

    const refEdges = result!.edges.filter(e => e.type === 'references')
    expect(refEdges.length).toBe(2)
  })

  test('parses generic JSON', () => {
    const content = JSON.stringify({
      database: { host: 'localhost' },
      server: { port: 3000 },
    })

    const result = parser.parse('/repo/config.json', content)
    expect(result).not.toBeNull()
    expect(result!.nodes.length).toBe(2)
  })

  test('returns null for invalid JSON', () => {
    const result = parser.parse('/repo/bad.json', '{invalid json}')
    expect(result).toBeNull()
  })
})

// ============================================================
// TerraformParser (P1)
// ============================================================

describe('TerraformParser', () => {
  const parser = new TerraformParser()

  test('parses Terraform resources and variables', () => {
    const content = `
variable "region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type    = string
  default = "t3.micro"
}

resource "aws_instance" "web" {
  ami           = "ami-12345"
  instance_type = var.instance_type

  tags = {
    Name = "web-server"
  }
}

resource "aws_security_group" "web_sg" {
  name = "web-sg"
}

output "instance_ip" {
  value = aws_instance.web.public_ip
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "3.0.0"
}
`.trim()

    const result = parser.parse('/infra/main.tf', content)
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('terraform')

    // Resources
    const resources = result!.nodes.filter(n => n.kind === 'resource')
    expect(resources.length).toBe(2)

    // Variables
    const variables = result!.nodes.filter(n => n.kind === 'variable')
    expect(variables.length).toBe(2)

    // Outputs
    const outputs = result!.nodes.filter(n => n.kind === 'output')
    expect(outputs.length).toBe(1)

    // Modules
    const modules = result!.nodes.filter(n => n.kind === 'module')
    expect(modules.length).toBe(1)

    // Resource references variable
    const refEdges = result!.edges.filter(e => e.type === 'references')
    expect(refEdges.length).toBeGreaterThanOrEqual(1)

    // Module uses source
    const usesEdges = result!.edges.filter(e => e.type === 'uses')
    expect(usesEdges.length).toBe(1)
  })

  test('returns null for empty file', () => {
    const result = parser.parse('/infra/empty.tf', '# Just comments')
    expect(result).toBeNull()
  })
})

// ============================================================
// OpenAPIParser (P1)
// ============================================================

describe('OpenAPIParser', () => {
  const parser = new OpenAPIParser()

  test('parses OpenAPI spec', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'My API', version: '1.0.0' },
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            tags: ['users'],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/UserList' },
                  },
                },
              },
            },
          },
          post: {
            operationId: 'createUser',
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/User' },
                },
              },
            },
          },
        },
        '/users/{id}': {
          get: {
            operationId: 'getUser',
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
          },
          UserList: {
            type: 'object',
            properties: {
              items: { $ref: '#/components/schemas/User' },
            },
          },
        },
      },
    }

    const result = parser.parse('/api/openapi.json', JSON.stringify(spec))
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('openapi')

    // API
    const apis = result!.nodes.filter(n => n.kind === 'api')
    expect(apis.length).toBe(1)
    expect(apis[0].name).toBe('My API')

    // Paths
    const paths = result!.nodes.filter(n => n.kind === 'path')
    expect(paths.length).toBe(2)

    // Operations
    const ops = result!.nodes.filter(n => n.kind === 'operation')
    expect(ops.length).toBe(3)

    // Schemas
    const schemas = result!.nodes.filter(n => n.kind === 'schema')
    expect(schemas.length).toBe(2)

    // References
    const refEdges = result!.edges.filter(e => e.type === 'references')
    expect(refEdges.length).toBeGreaterThanOrEqual(2)

    // Returns
    const returnEdges = result!.edges.filter(e => e.type === 'returns')
    expect(returnEdges.length).toBeGreaterThanOrEqual(1)
  })

  test('ignores non-OpenAPI JSON files', () => {
    const result = parser.parse('/repo/data.json', JSON.stringify({ key: 'value' }))
    expect(result).toBeNull()
  })

  test('detects OpenAPI by content structure', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/health': { get: {} },
      },
    }
    const result = parser.parse('/repo/spec.json', JSON.stringify(spec))
    expect(result).not.toBeNull()
  })
})

// ============================================================
// GraphQLParser (P1)
// ============================================================

describe('GraphQLParser', () => {
  const parser = new GraphQLParser()

  test('parses GraphQL schema', () => {
    const content = `
type User {
  id: ID!
  name: String!
  email: String!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  content: String!
  author: User!
}

type Query {
  users: [User!]!
  user(id: ID!): User
  posts: [Post!]!
}

type Mutation {
  createUser(name: String!, email: String!): User!
  createPost(title: String!, content: String!, authorId: ID!): Post!
}
`.trim()

    const result = parser.parse('/api/schema.graphql', content)
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('graphql')

    // Types
    const types = result!.nodes.filter(n => n.kind === 'type')
    expect(types.length).toBe(4) // User, Post, Query, Mutation

    // Fields
    const fields = result!.nodes.filter(n => n.kind === 'field')
    expect(fields.length).toBeGreaterThanOrEqual(10)

    // Queries
    const queries = result!.nodes.filter(n => n.kind === 'query')
    expect(queries.length).toBe(3)

    // Mutations
    const mutations = result!.nodes.filter(n => n.kind === 'mutation')
    expect(mutations.length).toBe(2)

    // Field references
    const refEdges = result!.edges.filter(e => e.type === 'references')
    expect(refEdges.length).toBeGreaterThanOrEqual(4)

    // Return type edges
    const returnEdges = result!.edges.filter(e => e.type === 'returns')
    expect(returnEdges.length).toBeGreaterThanOrEqual(5)
  })

  test('parses GraphQL with enums and interfaces', () => {
    const content = `
enum Role {
  ADMIN
  USER
  GUEST
}

interface Node {
  id: ID!
}

type User implements Node {
  id: ID!
  role: Role!
}
`.trim()

    const result = parser.parse('/api/types.graphql', content)
    expect(result).not.toBeNull()
    expect(result!.nodes.some(n => n.kind === 'enum')).toBe(true)
    expect(result!.nodes.some(n => n.kind === 'interface')).toBe(true)
  })
})

// ============================================================
// ProtobufParser (P1)
// ============================================================

describe('ProtobufParser', () => {
  const parser = new ProtobufParser()

  test('parses protobuf schema', () => {
    const content = `
syntax = "proto3";
package example;

message User {
  int32 id = 1;
  string name = 2;
  string email = 3;
  repeated string roles = 4;
}

message GetUserRequest {
  int32 user_id = 1;
}

message GetUserResponse {
  User user = 1;
}

service UserService {
  rpc GetUser (GetUserRequest) returns (GetUserResponse);
  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);
}
`.trim()

    const result = parser.parse('/proto/user.proto', content)
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('protobuf')

    // Messages
    const messages = result!.nodes.filter(n => n.kind === 'message')
    expect(messages.length).toBe(3)

    // Service
    const services = result!.nodes.filter(n => n.kind === 'service')
    expect(services.length).toBe(1)

    // RPCs
    const rpcs = result!.nodes.filter(n => n.kind === 'rpc')
    expect(rpcs.length).toBe(2)

    // Fields
    const fields = result!.nodes.filter(n => n.kind === 'field')
    expect(fields.length).toBeGreaterThanOrEqual(6)

    // Service has RPC
    const hasRpcEdges = result!.edges.filter(e => e.type === 'has_rpc')
    expect(hasRpcEdges.length).toBe(2)

    // RPC accepts/returns
    const acceptsEdges = result!.edges.filter(e => e.type === 'accepts')
    const returnsEdges = result!.edges.filter(e => e.type === 'returns')
    expect(acceptsEdges.length).toBe(2)
    expect(returnsEdges.length).toBe(2)

    // Field references
    const refEdges = result!.edges.filter(e => e.type === 'references')
    expect(refEdges.length).toBeGreaterThanOrEqual(1)
  })

  test('handles enum types', () => {
    const content = `
enum Status {
  UNKNOWN = 0;
  ACTIVE = 1;
  INACTIVE = 2;
}
`.trim()

    const result = parser.parse('/proto/enums.proto', content)
    expect(result).not.toBeNull()
    expect(result!.nodes.some(n => n.kind === 'enum')).toBe(true)
  })
})

// ============================================================
// SQLParser (P1)
// ============================================================

describe('SQLParser', () => {
  const parser = new SQLParser()

  test('parses CREATE TABLE statements', () => {
    const content = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  department_id INTEGER REFERENCES departments(id)
);

CREATE TABLE departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  owner_id INTEGER,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_projects_owner ON projects (owner_id);
`.trim()

    const result = parser.parse('/db/schema.sql', content)
    expect(result).not.toBeNull()
    expect(result!.parser).toBe('sql')

    // Tables
    const tables = result!.nodes.filter(n => n.kind === 'table')
    expect(tables.length).toBe(3)
    expect(tables.map(t => t.name)).toContain('users')
    expect(tables.map(t => t.name)).toContain('departments')
    expect(tables.map(t => t.name)).toContain('projects')

    // Columns
    const columns = result!.nodes.filter(n => n.kind === 'column')
    expect(columns.length).toBeGreaterThanOrEqual(8)

    // Indexes
    const indexes = result!.nodes.filter(n => n.kind === 'index')
    expect(indexes.length).toBe(2)

    // Foreign key references
    const refEdges = result!.edges.filter(e => e.type === 'references')
    expect(refEdges.length).toBeGreaterThanOrEqual(2)

    // Index edges
    const indexEdges = result!.edges.filter(e => e.type === 'indexes')
    expect(indexEdges.length).toBe(2)
  })

  test('handles IF NOT EXISTS', () => {
    const content = `
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  data TEXT
);
`.trim()

    const result = parser.parse('/db/sessions.sql', content)
    expect(result).not.toBeNull()
    expect(result!.nodes.some(n => n.kind === 'table')).toBe(true)
  })

  test('handles ALTER TABLE foreign keys', () => {
    const content = `
CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INTEGER);
CREATE TABLE users (id SERIAL PRIMARY KEY);
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
`.trim()

    const result = parser.parse('/db/alter.sql', content)
    expect(result).not.toBeNull()
    const refEdges = result!.edges.filter(e => e.type === 'references')
    expect(refEdges.length).toBeGreaterThanOrEqual(1)
  })

  test('returns null for empty file', () => {
    const result = parser.parse('/db/empty.sql', '-- Just comments')
    expect(result).toBeNull()
  })
})

// ============================================================
// ParserRegistry
// ============================================================

describe('ParserRegistry', () => {
  test('createDefaultRegistry registers all parsers', () => {
    const registry = createDefaultRegistry()

    // Test by parsing various file types
    const dockerResult = registry.parse('/app/Dockerfile', 'FROM node:18\nEXPOSE 3000')
    expect(dockerResult).not.toBeNull()
    expect(dockerResult!.parser).toBe('dockerfile')

    const jsonResult = registry.parse('/repo/package.json', '{"name":"test","scripts":{"build":"tsc"}}')
    expect(jsonResult).not.toBeNull()
    expect(jsonResult!.parser).toBe('json')

    const tfResult = registry.parse('/infra/main.tf', 'resource "aws_instance" "web" { }')
    expect(tfResult).not.toBeNull()
    expect(tfResult!.parser).toBe('terraform')

    const gqlResult = registry.parse('/api/schema.graphql', 'type User { id: ID! }')
    expect(gqlResult).not.toBeNull()
    expect(gqlResult!.parser).toBe('graphql')

    const protoResult = registry.parse('/proto/user.proto', 'message User { int32 id = 1; }')
    expect(protoResult).not.toBeNull()
    expect(protoResult!.parser).toBe('protobuf')

    const sqlResult = registry.parse('/db/schema.sql', 'CREATE TABLE users (id INTEGER PRIMARY KEY);')
    expect(sqlResult).not.toBeNull()
    expect(sqlResult!.parser).toBe('sql')
  })

  test('returns null for unsupported file types', () => {
    const registry = createDefaultRegistry()
    const result = registry.parse('/app/main.py', 'print("hello")')
    expect(result).toBeNull()
  })

  test('registry dispatches to correct parser by extension', () => {
    const registry = new ParserRegistry()
    const yamlParser = new YAMLParser()
    registry.register(yamlParser)

    // .yml files should be handled
    const result = registry.parse('/repo/test.yml', 'key: value')
    expect(result).not.toBeNull()

    // .py files should not
    const pyResult = registry.parse('/repo/test.py', 'x = 1')
    expect(pyResult).toBeNull()
  })

  test('file patterns take priority over extensions', () => {
    const registry = new ParserRegistry()
    const dockerParser = new DockerfileParser()
    registry.register(dockerParser)

    // Dockerfile has no extension, matched by pattern
    const result = registry.parse('/app/Dockerfile', 'FROM node:18')
    expect(result).not.toBeNull()
  })
})

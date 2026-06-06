/**
 * MyBatisExtractor tests — verify MyBatis XML mapper parsing.
 */

import { describe, test, expect } from 'bun:test'
import { MyBatisExtractor } from '../extractors/mybatis-extractor.js'

describe('MyBatisExtractor', () => {
  const mapperXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.UserMapper">
  <select id="findById" resultType="com.example.User" parameterType="long">
    SELECT * FROM users WHERE id = #{id}
  </select>

  <insert id="insertUser" parameterType="com.example.User">
    INSERT INTO users (name, email) VALUES (#{name}, #{email})
  </insert>

  <update id="updateUser" parameterType="com.example.User">
    UPDATE users SET name = #{name} WHERE id = #{id}
  </update>

  <delete id="deleteUser">
    DELETE FROM users WHERE id = #{id}
  </delete>

  <sql id="userColumns">
    id, name, email, created_at
  </sql>

  <select id="findAll" resultType="com.example.User">
    SELECT <include refid="userColumns"/> FROM users
  </select>

  <select id="findWithExtra" resultType="com.example.User">
    SELECT <include refid="com.example.CommonMapper.extraColumns"/> FROM users
  </select>
</mapper>`

  test('creates file node for mapper XML', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    const fileNode = result.nodes.find(n => n.kind === 'file')
    expect(fileNode).toBeDefined()
    expect(fileNode!.name).toBe('UserMapper.xml')
    expect(fileNode!.language).toBe('xml')
  })

  test('extracts select statements', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    const findById = result.nodes.find(n => n.name === 'findById')
    expect(findById).toBeDefined()
    expect(findById!.kind).toBe('method')
    expect(findById!.qualified_name).toBe('com.example.UserMapper::findById')
    expect(findById!.signature).toBe('SELECT param=long result=com.example.User')
  })

  test('extracts insert statements', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    const insert = result.nodes.find(n => n.name === 'insertUser')
    expect(insert).toBeDefined()
    expect(insert!.signature).toBe('INSERT param=com.example.User')
  })

  test('extracts update statements', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    const update = result.nodes.find(n => n.name === 'updateUser')
    expect(update).toBeDefined()
    expect(update!.signature).toBe('UPDATE param=com.example.User')
  })

  test('extracts delete statements', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    const del = result.nodes.find(n => n.name === 'deleteUser')
    expect(del).toBeDefined()
    expect(del!.signature).toBe('DELETE')
  })

  test('extracts sql fragments', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    const sql = result.nodes.find(n => n.name === 'userColumns')
    expect(sql).toBeDefined()
    expect(sql!.kind).toBe('method')
    expect(sql!.signature).toBe('<sql>')
    expect(sql!.qualified_name).toBe('com.example.UserMapper::userColumns')
  })

  test('extracts include references', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    // Local include: refid="userColumns" → namespace::userColumns
    const findAll = result.nodes.find(n => n.name === 'findAll')
    expect(findAll).toBeDefined()

    const localRef = result.unresolved_references.find(
      r => r.from_node_id === findAll!.id && r.reference_name === 'com.example.UserMapper::userColumns',
    )
    expect(localRef).toBeDefined()

    // Cross-namespace include: refid="com.example.CommonMapper.extraColumns"
    const findWithExtra = result.nodes.find(n => n.name === 'findWithExtra')
    expect(findWithExtra).toBeDefined()

    const crossRef = result.unresolved_references.find(
      r => r.from_node_id === findWithExtra!.id && r.reference_name === 'com::example::CommonMapper::extraColumns',
    )
    expect(crossRef).toBeDefined()
  })

  test('creates containment edges from file to statements', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    const fileNode = result.nodes.find(n => n.kind === 'file')
    const containsEdges = result.edges.filter(e => e.source === fileNode!.id && e.kind === 'contains')
    expect(containsEdges.length).toBe(7) // 4 CRUD + 1 sql + findAll + findWithExtra
  })

  test('returns only file node for non-mapper XML', () => {
    const pomXml = `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
</project>`
    const extractor = new MyBatisExtractor('/pom.xml', pomXml)
    const result = extractor.extract()

    expect(result.nodes.length).toBe(1) // file node only
    expect(result.nodes[0]!.kind).toBe('file')
  })

  test('returns only file node for mapper without namespace', () => {
    const xml = `<mapper><select id="foo">SELECT 1</select></mapper>`
    const extractor = new MyBatisExtractor('/bad.xml', xml)
    const result = extractor.extract()

    expect(result.nodes.length).toBe(1) // file node only
  })

  test('includes SQL preview as docstring', () => {
    const extractor = new MyBatisExtractor('/src/mapper/UserMapper.xml', mapperXml)
    const result = extractor.extract()

    const findById = result.nodes.find(n => n.name === 'findById')
    expect(findById!.docstring).toContain('SELECT * FROM users WHERE id')
  })

  test('duration_ms is non-negative', () => {
    const result = new MyBatisExtractor('/test.xml', mapperXml).extract()
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })
})

import { uri, attempt } from './utils'

const FETCH_LIMIT = 50

const normalizeDoc = (doc, doctype) => {
  const id = doc._id || doc.id
  return { id, _id: id, _type: doctype, ...doc }
}

/**
 * Abstracts a collection of documents of the same doctype, providing
 * CRUD methods and other helpers.
 */
export default class DocumentCollection {
  constructor(doctype, link) {
    this.doctype = doctype
    this.link = link
    this.indexes = {}
  }

  /**
   * Lists all documents of the collection, without filters.
   *
   * The returned documents are paginated by the stack.
   *
   * @param  {{limit, skip}} options The pagination options.
   * @return {{data, meta, skip, next}} The JSON API conformant response.
   * @throws {FetchError}
   */
  async all(options = {}) {
    const { limit = FETCH_LIMIT, skip = 0 } = options
    // If no document of this doctype exist, this route will return a 404,
    // so we need to try/catch and return an empty response object in case of a 404
    try {
      const resp = await this.link.fetch(
        'GET',
        uri`/data/${
          this.doctype
        }/_all_docs?include_docs=true&limit=${limit}&skip=${skip}`
      )
      // WARN: looks like this route returns something looking like a couchDB design doc, we need to filter it:
      const rows = resp.rows.filter(row => !row.doc.hasOwnProperty('views'))
      // WARN: the JSON response from the stack is not homogenous with other routes (offset? rows? total_rows?)
      return {
        data: rows.map(row => normalizeDoc(row.doc, this.doctype)),
        meta: { count: resp.total_rows },
        skip: resp.offset,
        next: resp.offset + rows.length <= resp.total_rows
      }
    } catch (error) {
      if (error.message.match(/not_found/)) {
        return { data: [], meta: { count: 0 }, skip: 0, next: false }
      }
      throw error
    }
  }

  /**
   * Returns a filtered list of documents using a Mango selector.
   *
   * The returned documents are paginated by the stack.
   *
   * @param  {Object} selector The Mango selector.
   * @param  {{sort, fields, limit, skip, indexId}} options The query options.
   * @return {{data, meta, skip, next}} The JSON API conformant response.
   * @throws {FetchError}
   */
  async find(selector, options = {}) {
    const indexId =
      options.indexId ||
      (await this.getIndexId(this.getIndexFields({ ...options, selector })))
    const { fields, skip = 0, limit = FETCH_LIMIT } = options
    // Mango wants an array of single-property-objects...
    const sort = options.sort
      ? index.fields.map(f => ({ [f]: options.sort[f] || 'desc' }))
      : undefined

    const mangoOptions = {
      selector,
      use_index: indexId,
      // TODO: type and class should not be necessary, it's just a temp fix for a stack bug
      fields: fields ? [...fields, '_id', '_type', 'class'] : undefined,
      limit,
      skip,
      sort
    }
    const resp = await this.link.fetch(
      'POST',
      uri`/data/${this.doctype}/_find`,
      mangoOptions
    )
    return {
      data: resp.docs.map(doc => normalizeDoc(doc, this.doctype)),
      // Mango queries don't return the total count of rows, so if next = true,
      // we return a `meta.count` greater than the count of rows we have so that
      // 'fetchMore' features would work
      meta: {
        count: resp.next ? skip + resp.docs.length + 1 : resp.docs.length
      },
      next: resp.next,
      skip
    }
  }

  async create({ _id, _type, ...document }) {
    const resp = await this.link.fetch(
      'POST',
      uri`/data/${this.doctype}/`,
      document
    )
    return {
      data: [normalizeDoc(resp.data, this.doctype)]
    }
  }

  async update(document) {
    const resp = await this.link.fetch(
      'PUT',
      uri`/data/${this.doctype}/${document._id}`,
      document
    )
    return {
      data: [normalizeDoc(resp.data, this.doctype)]
    }
  }

  async destroy({ _id, _rev, ...document }) {
    await this.link.fetch(
      'DELETE',
      uri`/data/${this.doctype}/${_id}?rev=${_rev}`
    )
    return
  }

  async getIndexId(fields) {
    const indexName = this.getIndexNameFromFields(fields)
    if (!this.indexes[indexName]) {
      this.indexes[indexName] = await this.createIndex(fields)
    }
    return this.indexes[indexName].id
  }

  async createIndex(fields) {
    const indexDef = { index: { fields } }
    const resp = await this.link.fetch(
      'POST',
      uri`/data/${this.doctype}/_index`,
      indexDef
    )
    const indexResp = {
      id: resp.id,
      fields
    }
    if (resp.result === 'exists') return indexResp

    // indexes might not be usable right after being created; so we delay the resolving until they are
    const selector = { [fields[0]]: { $gt: null } }
    const options = { indexId: indexResp.id }

    if (await attempt(this.find(selector, options))) return indexResp
    // one retry
    await sleep(1000)
    if (await attempt(this.find(selector, options))) return indexResp
    await sleep(500)
    return indexResp
  }

  getIndexNameFromFields(fields) {
    return `by_${fields.sort((a, b) => a.localeCompare(b)).join('_and_')}`
  }

  /**
   * Compute fields that should be indexed for a mango
   * query to work
   *
   * @param  {Object} options - Mango query options
   * @return {Array} - Fields to index
   */
  getIndexFields({ selector, sort = {} }) {
    return Array.from(new Set([...Object.keys(selector), ...Object.keys(sort)]))
  }
}

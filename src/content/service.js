import path from 'path'
import fs from 'fs'

import _ from 'lodash'
import Promise from 'bluebird'
import glob from 'glob'
import uuid from 'uuid'

import helpers from '../database/helpers'
import { now } from '~/util'

const getShortUid = () =>
  uuid
    .v4()
    .split('-')
    .join('')
    .substr(0, 6)

module.exports = ({ db, botfile, projectLocation, logger }) => {
  const categories = []
  const categoryById = {}
  const dataByCategory = {}
  const dataByCategoryById = {}
  const fileById = {}

  const formDir = path.resolve(projectLocation, botfile.formsDir || './content/forms')
  const formDataDir = path.resolve(projectLocation, botfile.formsDataDir || './content/forms_data')

  const loadCategory = file => {
    const filePath = path.resolve(formDir, './' + file)
    // eslint-disable-next-line no-eval
    const category = eval('require')(filePath) // Dynamic loading require eval for Webpack
    const requiredFields = ['id', 'title', 'jsonSchema']

    requiredFields.forEach(field => {
      if (_.isNil(category[field])) {
        throw new Error(field + ' is required but missing in Content Form file: ' + file)
      }
    })

    category.id = category.id.toLowerCase()

    if (categoryById[category.id]) {
      throw new Error('There is already a form with id=' + category.id)
    }

    categoryById[category.id] = category
    categories.push(category)

    return category
  }

  const readDataFromFile = file => {
    const filePath = path.resolve(formDataDir, './' + file)

    if (!fs.existsSync(filePath)) {
      return
    }
    try {
      const json = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(json)
      if (!Array.isArray(data)) {
        throw new Error(`{file} expected to contain array, contents ignored`)
      }
      return data
    } catch (err) {
      logger.warn(`Error reading data from ${file}`, err)
    }
  }

  const loadData = (category, file) => {
    let data = []
    try {
      data = readDataFromFile(file)
    } catch (e) {}

    dataByCategory[category.id] = data
    const index = (dataByCategoryById[category.id] = {})
    data.forEach(datum => {
      index[datum.id] = datum
    })

    fileById[category.id] = file
  }

  const saveData = categoryId => {
    const filePath = path.resolve(formDataDir, './' + fileById[categoryId])
    fs.writeFileSync(filePath, JSON.stringify(dataByCategory[categoryId], null, 2))
  }

  const init = async () => {
    if (!fs.existsSync(formDir)) {
      return
    }

    const searchOptions = { cwd: formDir }

    const files = await Promise.fromCallback(callback => glob('**/*.form.js', searchOptions, callback))

    files.forEach(file => {
      try {
        loadCategory(file)
        loadData(file.replace(/\.form\.js$/, '.json'))
      } catch (err) {
        logger.warn('[Content Manager] Could not load Form: ' + file, err)
      }
    })

    return
  }

  const listAvailableCategories = () =>
    categories.map(category => ({
      id: category.id,
      title: category.title,
      description: category.description,
      count: dataByCategory[category.id].length
    }))

  const getCategorySchema = categoryId => {
    const category = categoryById[categoryId]
    if (!category) {
      return null
    }

    return {
      json: category.jsonSchema,
      ui: category.uiSchema,
      title: category.title,
      description: category.description,
      ummBloc: category.ummBloc
    }
  }

  const createOrUpdateCategoryItem = async ({ itemId, categoryId, formData }) => {
    categoryId = categoryId && categoryId.toLowerCase()
    const category = categoryById[categoryId]

    if (_.isNil(category)) {
      throw new Error(`Category "${categoryId}" is not a valid registered categoryId`)
    }

    if (_.isNil(formData) || !_.isObject(formData)) {
      throw new Error('"formData" must be a valid object')
    }

    const data = (category.computeFormData && (await category.computeFormData(formData))) || formData
    const metadata = (category.computeMetadata && (await category.computeMetadata(formData))) || []
    const previewText = (category.computePreviewText && (await category.computePreviewText(formData))) || 'No preview'

    if (!_.isArray(metadata)) {
      throw new Error('computeMetadata must return an array of strings')
    }

    if (!_.isString(previewText)) {
      throw new Error('computePreviewText must return a string')
    }

    if (_.isNil(data) || !_.isObject(data)) {
      throw new Error('computeFormData must return a valid object')
    }

    const body = {
      data,
      formData,
      metadata,
      previewText,
      created_by: 'admin',
      created_on: now()
    }

    if (itemId) {
      _.assign(dataByCategoryById[categoryId][itemId], body)
    } else {
      const prefix = (category.ummBloc || categoryId).replace(/^#/, '')
      const randomId = `${prefix}-${getShortUid()}`

      body.id = randomId
      dataByCategory.push(body)
      dataByCategoryById[categoryId][randomId] = body
    }

    saveData(categoryId)
  }

  const transformCategoryItem = item => {
    if (!item) {
      return item
    }

    const metadata = _.filter(item.metadata || [], i => i.length > 0)

    return {
      id: item.id,
      data: item.data,
      formData: item.formData,
      categoryId: item.categoryId,
      previewText: item.previewText,
      metadata,
      createdBy: item.created_by,
      createdOn: item.created_on
    }
  }

  const listCategoryItems = categoryId => {
    return dataByCategoryById[categoryId].map(transformCategoryItem)
  }

  const deleteCategoryItems = async ids => {
    if (!_.isArray(ids) || _.some(ids, id => !_.isString(id))) {
      throw new Error('Expected an array of Ids to delete')
    }

    ids.forEach() // TODO cross-category
  }

  const getItem = async itemId => {
    const knex = await db.get()

    const item = await knex('content_items')
      .where({ id: itemId })
      .then()
      .get(0)
      .then()

    return transformCategoryItem(item)
  }

  const getItemsByMetadata = async metadata => {
    const knex = await db.get()

    const items = await knex('content_items')
      .where('metadata', 'like', '%|' + metadata + '|%')
      .then()

    return transformCategoryItem(items)
  }

  return {
    init,
    listAvailableCategories,
    getCategorySchema,

    createOrUpdateCategoryItem,
    listCategoryItems,
    deleteCategoryItems,

    getItem,
    getItemsByMetadata
  }
}

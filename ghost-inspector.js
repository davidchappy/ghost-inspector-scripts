require("dotenv").config({ path: __dirname + "/./../.env" })
const yargs = require("yargs")
const readline = require("readline")
const fetch = require("node-fetch")
const pluralize = require("pluralize")

const API_KEY = process.env.GHOST_INSPECTOR_API_KEY
const ORG_ID = process.env.GHOST_INSPECTOR_ORG_ID
const POLL_RATE = 3000

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const argv = yargs
  .option("check", {
    description: "Check for running tests",
    alias: "c",
    type: "boolean"
  })
  .option("list", {
    description: "List all available tests",
    alias: "l",
    type: "boolean"
  })
  .option("testenv", {
    description: "Environment to run tests against",
    alias: "e",
    type: "string"
  })
  .option("filter", {
    description: "Filter tests by name",
    alias: "f",
    type: "string"
  })
  .option("yes", {
    description: "Run tests without prompting",
    alias: "y",
    type: "boolean"
  })
  .option("testid", {
    description: "Run a single test",
    alias: "t",
    type: "string"
  })
  .option("suite", {
    description: "Run a test suite",
    alias: "s",
    type: "string"
  })
  .help("help")
  .alias("help", "h").argv

const checkOnly = !!argv.check
const listOnly = !!argv.list
const domain =
  argv.testenv === "production" || argv.testenv === "prod"
    ? "pathwright"
    : argv.testenv === "staging"
    ? "pathwrightstaging"
    : "pantswright"
const filter = argv.filter
const skipConfirm = !!argv.yes
const singleTest = argv.testid || null

// Pick any number higher than the number of tests that could be running
let numberOfTestsRunning = 100000000
const failedTests = []
let testIds = []

const getAPIUrl = (path = "", applyParams = false) => {
  const base = `https://api.ghostinspector.com/v1/${path}?apiKey=${API_KEY}`
  let paramsString = ""
  if (applyParams) {
    const params = { domain }
    // TODO: add ability to specify a school? Require using SU?
    paramsString = Object.keys(params)
      .map(key => `&${key}=${params[key]}`)
      .join("")
  }
  return `${base}${paramsString}`
}

const getTestURL = id => `https://app.ghostinspector.com/tests/${id}`

const getAllTests = async () => {
  console.log("\n⏳ Fetching all tests...")

  const testsURL = getAPIUrl("tests/")
  const result = await fetch(testsURL)
  const json = await result.json()

  let testableTests = json.data.filter(test => !test.importOnly)
  if (filter) {
    testableTests = testableTests.filter(test =>
      test.name.toLowerCase().includes(filter.toLowerCase())
    )
    console.log(`🎚  Filter applied: ${filter}.`)
  }
  if (singleTest) {
    testableTests = testableTests.filter(test => test._id === singleTest)
    console.log(`🎚  Running single test: ${singleTest}.`)
  }
  if (!singleTest) {
    console.log(
      `🕵️  Found ${testableTests.length} ${pluralize(
        "test",
        testableTests.length
      )}.`
    )
  }

  return testableTests
}

const promptForConfirmation = async () => {
  const numberOfTests = testIds.length
  if (!numberOfTests) {
    console.log("😵 No tests to run!")
    rl.close()
    return false
  }

  const usageUrl = `https://app.ghostinspector.com/organizations/${ORG_ID}/usage`

  let question = `\n💡 You can visit ${usageUrl} to see how many more tests can be run this month.\n\nRun ${numberOfTests} ${pluralize(
    "test",
    numberOfTests
  )}? (y/N)`
  if (argv.testenv) {
    question = `${question}\nNote: tests will run against the ${domain} domain.\n`
  }

  const shouldRun = skipConfirm
    ? true
    : await new Promise(resolve => {
        rl.question(question, answer => resolve(answer.toLowerCase() === "y"))
      })

  return shouldRun ? true : rl.close()
}

const closeSession = () => {
  console.log("\nSee ya 👋")
  process.exit(0)
}

rl.on("close", closeSession)

const runTestsAndReport = async () => {
  runTests() // don't await because we want to poll for results
  await pollRunningTests()
}

const runTests = async () => {
  await Promise.all(
    testIds.map(async id => {
      const url = getAPIUrl(`tests/${id}/execute/`, true)
      // const url = `https://api.ghostinspector.com/v1/tests/${id}/execute/?apiKey=${API_KEY}&domain=${domain}`
      const result = await fetch(url)
      const json = await result.json()
      if (json.data && json.data.passing === false) {
        failedTests.push(id)
      }
    })
  )
}

const pollRunningTests = async () => {
  console.log(
    `\n🏎  Running ${testIds.length} ${pluralize("test", testIds.length)}...`
  )

  const poll = async () => {
    const runningTests = await getRunningTests()
    const running = runningTests.length

    if (running > 0) {
      if (running < numberOfTestsRunning) {
        numberOfTestsRunning = running
        console.log(
          `⏱  ${running} ${pluralize("test", running)} still running...`
        )
      }
      poll()
    } else {
      displayRunResults()
      closeSession()
    }
  }

  setTimeout(poll, POLL_RATE)
}

const displayRunResults = () => {
  console.log("🎉 Tests have finished running.")
  const failed = failedTests.length
  if (failed > 0) {
    let message = `\n😩  ${failed} ${pluralize("test", failed)} failed:`
    message += failedTests.map(id => `\n* ${getTestURL(id)}`)
    console.log(message)
  } else {
    console.log("\nNice!🙌 All tests are passing!")
  }
}

const getRunningTests = async () => {
  const url = getAPIUrl(`organizations/${ORG_ID}/running/`)
  // const runningUrl = `https://api.ghostinspector.com/v1/organizations/${ORG_ID}/running/?API_KEY=${API_KEY}`
  const result = await fetch(url)
  const json = await result.json()
  if (!json.data || json.errorType) {
    console.error("Error: ", json.errorType, "\n", json.message)
    rl.close()
  }
  return json.data || []
}

const runCheckOnly = async () => {
  console.log("⏳ Checking for running tests...")
  const runningTests = await getRunningTests()
  const count = runningTests.length
  if (count > 0) {
    console.log(`\n${count} ${pluralize("test", count)} currently running...`)
    const testLinks = runningTests.map(
      result => `* ${getTestURL(result.test._id)}`
    )
    console.log(testLinks.join(""))
  } else {
    console.log("🏝  No tests running at the moment!")
  }
  closeSession()
}

const getListOnly = async () => {
  const tests = await getAllTests()
  const testsOutput = tests
    .map(test => {
      const name = test.name
      const id = test._id
      const url = getTestURL(id)
      return `🧪 ${name}\n${url}\n`
    })
    .join("\n")
  console.log("\n")
  console.log(testsOutput)
  console.log(
    `👆 View ${tests.length} ${pluralize(
      "test",
      tests.length
    )} above.\nNote: import-only tests are not included.`
  )
  closeSession()
}

const run = async () => {
  const tests = await getAllTests()
  testIds = tests.map(test => test._id)
  const shouldRun = await promptForConfirmation()
  if (shouldRun) {
    runTestsAndReport()
  }
}

if (checkOnly) {
  runCheckOnly()
} else if (listOnly) {
  getListOnly()
} else {
  run()
}

const {template, isPlainObject, castArray} = require('lodash');
const marked = require('marked');
const TerminalRenderer = require('marked-terminal');
const envCi = require('env-ci');
const hookStd = require('hook-std');
const pkg = require('./package.json');
const hideSensitive = require('./lib/hide-sensitive');
const getConfig = require('./lib/get-config');
const verify = require('./lib/verify');
const getNextVersion = require('./lib/get-next-version');
const getCommits = require('./lib/get-commits');
const getLastRelease = require('./lib/get-last-release');
const getTags = require('./lib/get-tags');
const {extractErrors} = require('./lib/utils');
const getBranches = require('./lib/branches');
const getGitAuthUrl = require('./lib/get-git-auth-url');
const logger = require('./lib/logger');
const {isGitRepo, verifyAuth, unshallow, gitHead: getGitHead, tag, push} = require('./lib/git');
const getError = require('./lib/get-error');

marked.setOptions({renderer: new TerminalRenderer()});

async function run(options, plugins) {
  if (!await isGitRepo()) {
    throw getError('ENOGITREPO');
  }

  const {isCi, branch: ciBranch, isPr} = envCi();

  if (!isCi && !options.dryRun && !options.noCi) {
    logger.log('This run was not triggered in a known CI environment, running in dry-run mode.');
    options.dryRun = true;
  } else {
    // When running on CI, prevent the `git` CLI to prompt for username/password. See #703.
    process.env.GIT_ASKPASS = 'echo';
    process.env.GIT_TERMINAL_PROMPT = 0;
  }

  if (isCi && isPr && !options.noCi) {
    logger.log("This run was triggered by a pull request and therefore a new version won't be published.");
    return;
  }

  // Verify config
  await verify(options);

  // Unshallow the repo in order to get all the tags
  await unshallow();

  // Normalize and verify branches
  options.branches = await getBranches(await getTags(options));

  const branch = options.branches.find(({name}) => name === ciBranch);

  if (branch) {
    logger.log(
      `This test run was triggered on the branch ${ciBranch}, while semantic-release is configured to only publish from ${options.branches
        .map(({name}) => name)
        .join(', ')}, therefore a new version won’t be published.`
    );
    return false;
  }

  options.repositoryUrl = await getGitAuthUrl(options);
  if (!await verifyAuth(options.repositoryUrl, branch.name)) {
    throw getError('EGITNOPERMISSION', {options});
  }

  logger.log('Run automated release from branch %s', ciBranch);
  logger.log('Call plugin %s', 'verify-conditions');
  await plugins.verifyConditions({options, logger}, {settleAll: true});

  const lastRelease = await getLastRelease(branch, logger);

  // TODO
  // If lastRelease is also present in any upper branch which is not a prerelease
  //  Check if in range of its branch
  //    => if not throw error
  //    => If yes, nextRelease is lastRelease and call publish addChannel and success/fail
  // If not a merge, get next version and check if is in range
  //  => if not throw error
  //  => If yes, compute nextRelease with getCommits, analyzeCommits and call verifyRelease and prepare

  // Send commits when changing channel? Probably not. Make more sens to have dedicated plugin for channel change

  // if (isMerge(lastRelease, branches)) {
  //   if (semver.satisfies(lastRelease.version, branch.range)) {
  //     nextRelease = lastRelease;
  //     // Call addChannel and success/fail
  //     // Or return lastRelease and nextRelease
  //   } else {
  //     // throw error illegal merge
  //   }
  // } else {
  //   const commits = await getCommits(lastRelease.gitHead, branch, logger);
  //   const type = await plugins.analyzeCommits({
  //     options,
  //     logger,
  //     lastRelease,
  //     commits: commits.filter(commit => !/\[skip\s+release\]|\[release\s+skip\]/i.test(commit.message)),
  //   });
  //   if (!type) {
  //     logger.log('There are no relevant changes, so no new version is released.');
  //     return;
  //   }
  //   const version = getNextVersion(type, lastRelease, logger);
  //
  //   const nextRelease = {
  //     type,
  //     version,
  //     channel,
  //     gitHead: await getGitHead(),
  //     gitTag: template(options.tagFormat)({version}),
  //   };
  //   // Or return lastRelease and null?
  // }

  const {channel} = branch;
  const commits = await getCommits(lastRelease.gitHead, branch, logger);

  logger.log('Call plugin %s', 'analyze-commits');
  const type = await plugins.analyzeCommits({
    options,
    logger,
    lastRelease,
    commits: commits.filter(commit => !/\[skip\s+release\]|\[release\s+skip\]/i.test(commit.message)),
  });
  if (!type) {
    logger.log('There are no relevant changes, so no new version is released.');
    return;
  }

  // TODO rework next version for determining the version of pre-release
  // TODO determine next version only if not a merge
  const version = getNextVersion(type, lastRelease, logger);
  // TODO verify if release match branch range (even it's a downstream merge)
  // TODO pass channel
  // TODO in case of merge pass the lastRelease as nextRelease
  const nextRelease = {
    type,
    version,
    channel,
    gitHead: await getGitHead(),
    gitTag: template(options.tagFormat)({version}),
  };

  logger.log('Call plugin %s', 'verify-release');
  await plugins.verifyRelease({options, logger, lastRelease, commits, nextRelease}, {settleAll: true});

  const generateNotesParam = {options, logger, lastRelease, commits, nextRelease};

  if (options.dryRun) {
    logger.log('Call plugin %s', 'generate-notes');
    const notes = await plugins.generateNotes(generateNotesParam);
    logger.log('Release note for version %s:\n', nextRelease.version);
    process.stdout.write(`${marked(notes)}\n`);
  } else {
    logger.log('Call plugin %s', 'generateNotes');
    nextRelease.notes = await plugins.generateNotes(generateNotesParam);

    logger.log('Call plugin %s', 'prepare');
    await plugins.prepare(
      {options, logger, lastRelease, commits, nextRelease},
      {
        getNextInput: async lastResult => {
          const newGitHead = await getGitHead();
          // If previous prepare plugin has created a commit (gitHead changed)
          if (lastResult.nextRelease.gitHead !== newGitHead) {
            nextRelease.gitHead = newGitHead;
            // Regenerate the release notes
            logger.log('Call plugin %s', 'generateNotes');
            nextRelease.notes = await plugins.generateNotes(generateNotesParam);
          }
          // Call the next publish plugin with the updated `nextRelease`
          return {options, logger, lastRelease, commits, nextRelease};
        },
      }
    );

    // Create the tag before calling the publish plugins as some require the tag to exists
    logger.log('Create tag %s', nextRelease.gitTag);
    await tag(nextRelease.gitTag);
    await push(options.repositoryUrl, branch);

    logger.log('Call plugin %s', 'publish');
    const releases = await plugins.publish(
      {options, logger, lastRelease, commits, nextRelease},
      // Add nextRelease and plugin properties to published release
      {transform: (release, step) => ({...(isPlainObject(release) ? release : {}), ...nextRelease, ...step})}
    );

    logger.log('Published release: %s', nextRelease.version);

    await plugins.success(
      {options, logger, lastRelease, commits, nextRelease, releases: castArray(releases)},
      {settleAll: true}
    );
  }
  return true;
}

function logErrors(err) {
  const errors = extractErrors(err).sort(error => (error.semanticRelease ? -1 : 0));
  for (const error of errors) {
    if (error.semanticRelease) {
      logger.log(`%s ${error.message}`, error.code);
      if (error.details) {
        process.stdout.write(`${marked(error.details)}\n`);
      }
    } else {
      logger.error('An error occurred while running semantic-release: %O', error);
    }
  }
}

async function callFail(plugins, options, error) {
  const errors = extractErrors(error).filter(error => error.semanticRelease);
  if (errors.length > 0) {
    try {
      await plugins.fail({options, logger, errors}, {settleAll: true});
    } catch (err) {
      logErrors(err);
    }
  }
}

module.exports = async opts => {
  logger.log(`Running %s version %s`, pkg.name, pkg.version);
  const unhook = hookStd({silent: false}, hideSensitive);
  try {
    const config = await getConfig(opts, logger);
    const {plugins, options} = config;
    try {
      const result = await run(options, plugins);
      unhook();
      return result;
    } catch (err) {
      if (!options.dryRun) {
        await callFail(plugins, options, err);
      }
      throw err;
    }
  } catch (err) {
    logErrors(err);
    unhook();
    throw err;
  }
};

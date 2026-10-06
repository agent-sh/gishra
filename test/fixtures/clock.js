'use strict';

// Advance the lease clock through the CLI without waiting a minute or editing state.
if (process.env.GISHRA_TEST_NOW) Date.now = () => Number(process.env.GISHRA_TEST_NOW);

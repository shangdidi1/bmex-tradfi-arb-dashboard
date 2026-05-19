import { Router, type IRouter } from "express";
import healthRouter from "./health";
import arbRouter from "./arb";
import bmexFundingRouter from "./bmex-funding";

const router: IRouter = Router();

router.use(healthRouter);
router.use(arbRouter);
router.use(bmexFundingRouter);

export default router;

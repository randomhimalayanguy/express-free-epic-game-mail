import express, { NextFunction, Request, Response } from 'express';
import mongoose, {Schema} from 'mongoose';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';
import { body , validationResult} from 'express-validator';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/free-epic-games';
const PORT = process.env.PORT || 5000;
const URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';

const app = express();

class AppError extends Error{
    statusCode : number;
    constructor(msg : string, statusCode = 500){
        super(msg);
        this.statusCode = statusCode;
    }
}


mongoose.connect(MONGODB_URI)
.then(()=>{
    console.log('Database connected');
    app.listen(Number(PORT), ()=>console.log('Server started'));
})
.catch((error)=>{
    console.log(`Can't connect to database : ${error}`);
    process.exit(1);
});


// Middleware
app.use(express.json());
app.use(cors());


// Interfaces
interface ApiResponse{
    data : {
        Catalog : {
            searchStore : {
                elements : any[]
            }
        }
    }
}


interface IGame{
    game : string,
    startDate : string,
    endDate : string
}


interface IMailList{
    email : string
}


// schema
const gamesListSchema = new Schema<IGame>({
    game : {type : String, required : true, unique : true},
    startDate : {type : String, required : true},
    endDate : {type : String}
}, {timestamps : true});


const mailListSchema = new Schema<IMailList>({
  email : {type : String, unique : true, required : true}
}, {timestamps : true});


// model
const gameList = mongoose.model('GamesList', gamesListSchema);
const mailList = mongoose.model('MailList', mailListSchema);



// Email configuration
const EMAIL_CONFIG = {
  service: 'gmail',
  user: process.env.EMAIL_USER || 'your-email@gmail.com',
  pass: process.env.EMAIL_PASS || 'your-app-password'
};

// Create email transporter
const transporter = nodemailer.createTransport({
  service: EMAIL_CONFIG.service,
  auth: {
    user: EMAIL_CONFIG.user,
    pass: EMAIL_CONFIG.pass
  }
});

// Verify transporter connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('Email transporter error:', error);
  } else {
    console.log('Email server is ready to send messages');
  }
});


// functions
const formatDate = (date : string) =>{
    const initial = date.split('T')[0].split('-');
    const formattedDate = initial.reverse().join('-');
    return formattedDate;
}

const formatToHTML = (games : IGame[]) : string => {
  const html = games.map((ele)=>{
    return `<h2>${ele.game}</h2>
    <h4>Start Date : ${ele.startDate}</h4>
    <h4>End Date : ${ele.endDate}</h4>`
  }).join('<br>');
  
  return html || '';
}

const curGame = async () : Promise<IGame[]> =>{
    const now = new Date();
    const response = await fetch(URL);
    const data = await response.json() as ApiResponse;

    const games = data.data.Catalog.searchStore.elements;

    const currentFreeGames = games.filter((ele)=>{
        const effectiveDateFormatted = new Date(ele.effectiveDate);
        return (ele.expiryDate !== null && now > effectiveDateFormatted);
    });

    const gamesDetail : IGame[] = currentFreeGames.map((ele) => {
        return {
            game : ele.title, 
            startDate : formatDate(ele.effectiveDate), 
            endDate : formatDate(ele.expiryDate)
        };
    });
    return gamesDetail;
}

const curGameFormatted = async ()=>{
    const gamesDetail = await curGame();
    const gameHTML = formatToHTML(gamesDetail);
    return gameHTML;
}

interface IMailOptions{
  to : string[], 
  subject? : string,
  text? : string, 
  html? : string
}

const sendMail = async ({to, subject = 'Free epic game', text, html} : IMailOptions) =>{
  try {
    const mailOptions = {
      from: EMAIL_CONFIG.user,
      to: to || 'somemail@gmail.com',
      subject: subject || 'Free epic game',
      text: text || '',
      html: html || ''
    };

    const info = await transporter.sendMail(mailOptions);
    return {msg : 'Mail sent', info};
  } catch (error) {
    throw new AppError(`Can't send mail : ${error}`, 500);
  }
}


// validators
const checkValidation = (req : Request, res : Response, next : NextFunction)=>{
  const errors = validationResult(req);
  if(!errors.isEmpty()){
    return next(new AppError(errors.array().map(ele => ele.msg).join(', '), 400));
  }
  next();
}


const emailVal = [
  body('email').isString().trim().isLength({min:6}).isEmail().withMessage('Enter a valid email'),

  checkValidation
];


// Routes
app.get(['/', '/checkgame'], async (req: Request, res: Response, next : NextFunction) => {
    try{
        const gamesDetail = await curGame();
        res.json({gamesDetail});
    }
    catch(err){
        console.log(`Can't check the game : ${err}`);
    }
});


app.post('/add-mail', emailVal, async (req : Request, res : Response, next : NextFunction)=>{
  try{
    const {email} = req.body;

    const mail = await mailList.findOne({email});
    if(mail)
      return next(new AppError(`Email already exist in the mailing list`, 400));
    
    const newMail = new mailList({email});
    await newMail.save();

    const html = await curGameFormatted();

    await sendMail({to : email, html});

    res.status(201).json({msg : "Email added to list"});
  }
  catch(err){
    next(new AppError(`Can't add mail : ${err}`));
  }
});


// Send email endpoint
app.post('/send-email', async (req: Request, res: Response, next : NextFunction) => {
  try{
    const { to, subject, text, html } = req.body;
    await sendMail({to, subject, text, html});
    res.status(200).json({msg : "Mail sent"});
  }
  catch(error){
    next(new AppError('Failed to send email', 500));
  }
});


app.post('/send-to-mailList', async (req : Request, res : Response, next : NextFunction)=>{
  try{
    const latestGame = await curGame();
    const latestSavedGame = await gameList.findOne({}, {sort : -1});

    const list = await mailList.find();
    const emailList = list.map(ele => ele.email);
    const html = await curGameFormatted();
    await sendMail({to : emailList, html});

  }
  catch(error){
    next(new AppError(`Can't send mails to mail list : ${error}`));
  }
});


app.post('/remove-mail', emailVal, async (req : Request, res : Response, next : NextFunction)=>{
  try{
    const { email } = req.body;
    
    const mail = await mailList.findOneAndDelete({email});

    res.status(200).json({msg : `Mail removed`});
  }
  catch(error){
    next(new AppError(`Can't remove the mail : ${error}`));
  }
});


// Error handling middleware
app.use((err: AppError, req: Request, res: Response, next : NextFunction) => {
  console.error(err.message);
  res.status(err.statusCode).json({ error: err.message});
});

